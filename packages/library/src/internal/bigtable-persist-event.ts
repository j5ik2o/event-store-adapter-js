import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import {
  encodeEventEnvelope,
  encodeSnapshotEnvelope,
  eventEnvelopeLength,
  snapshotEnvelopeLength,
} from "./bigtable-envelope";
import { guarded } from "./bigtable-guarded";
import { commitHead, readHead } from "./bigtable-head";
import { writeJournalRow } from "./bigtable-journal-row";
import { notifyJournalWriteFailure } from "./bigtable-journal-write-failure-notification";
import { retainBigtableHistory } from "./bigtable-snapshot-retention";
import {
  aggregatePrefixOf,
  type BigtableStoreResources,
} from "./bigtable-store-resources";
import { notifyRetentionFailure } from "./retention-failure-notification";
import {
  validateEvent,
  validateEventAndSnapshot,
} from "./validated-event-store";

const NANOS_PER_MILLI = BigInt(1000000);

export function createBigtablePersistEvent<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
): EventStore<PE, PS>["persistEvent"] {
  return async (event) => {
    const validated = validateEvent(event);
    if (validated.type === "err") return validated;
    return persist(resources, validated.value, undefined);
  };
}

export function createBigtablePersistEventAndSnapshot<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
): EventStore<PE, PS>["persistEventAndSnapshot"] {
  return async (event, snapshot) => {
    const validated = validateEventAndSnapshot(event, snapshot);
    if (validated.type === "err") return validated;
    return persist(resources, validated.value.event, validated.value.snapshot);
  };
}

function serialize<P>(
  serializer: { serialize(payload: P): Uint8Array },
  payload: P,
  what: string,
): Result<Uint8Array, EventStoreError> {
  try {
    const serialized = serializer.serialize(payload);
    if (!(serialized instanceof Uint8Array))
      throw new TypeError("serializer.serialize must return Uint8Array");
    return Result.ok(serialized);
  } catch (cause) {
    return Result.err(
      EventStoreError.serialization(
        "serialize",
        `${what} payload serialization failed`,
        cause,
      ),
    );
  }
}

const overLimit = (seqNr: number, snapshotSeqNr?: number) =>
  Result.err(
    EventStoreError.contractViolation({
      rule: "BT-16",
      seqNr,
      ...(snapshotSeqNr !== undefined ? { snapshotSeqNr } : {}),
    }),
  );

async function persist<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
  event: EventEnvelope<PE>,
  snapshot: SnapshotEnvelope<PS> | undefined,
): Promise<Result<void, EventStoreError>> {
  const { settings, hooks } = resources;
  const aid = `${event.aggregateId.typeName}-${event.aggregateId.value}`;
  const seqNr = event.seqNr;

  // 入力の検査と直列化を、保存先へ書く前に済ませる（BT-7）。
  const payload = serialize(settings.eventSerializer, event.payload, "event");
  if (payload.type === "err") return payload;
  const eventFields = {
    aid,
    seqNr,
    occurredAtNs: BigInt(event.occurredAt.getTime()) * NANOS_PER_MILLI,
    manifest: event.manifest,
    payload: payload.value,
  };
  if (eventEnvelopeLength(eventFields) > settings.envelopeLimitBytes)
    return overLimit(seqNr);
  let snapshotBytes: Uint8Array | undefined;
  if (snapshot !== undefined) {
    const aggregate = serialize(
      settings.snapshotSerializer,
      snapshot.aggregate,
      "snapshot",
    );
    if (aggregate.type === "err") return aggregate;
    const snapshotFields = {
      seqNr: snapshot.seqNr,
      manifest: snapshot.manifest,
      payload: aggregate.value,
    };
    if (snapshotEnvelopeLength(snapshotFields) > settings.envelopeLimitBytes)
      return overLimit(seqNr, snapshot.seqNr);
    snapshotBytes = encodeSnapshotEnvelope(snapshotFields);
  }
  const eventBytes = encodeEventEnvelope(eventFields);
  const keep = settings.retentionCount;

  const committed = await guarded("event append failed", async () => {
    const prefix = aggregatePrefixOf(resources, aid);
    // 手順 1・2: head を強整合で読み、入力の seq_nr を h に対して照合する（W-3・W-7・W-8）。
    const head = await readHead(resources.head, prefix, aid);
    const current = head?.seqNr ?? 0;
    if (seqNr <= current)
      return Result.err(
        EventStoreError.optimisticLockConflict({
          aggregateId: aid,
          seqNr,
          headSeqNr: current,
        }),
      );
    if (seqNr !== current + 1)
      return Result.err(
        EventStoreError.contractViolation({ rule: "W-8", seqNr }),
      );
    // 手順 3: 直前の確定済みイベント h を journal へ書き出す。確認できなければ、head を進めず保存先エラーにする。
    if (head !== undefined) {
      await hooks?.journalWritePrevious?.(aid, head.seqNr);
      await writeJournalRow(
        resources.journal,
        prefix,
        head.seqNr,
        head.lastEventBytes,
        keep === undefined ? undefined : head.tailSnapshotBytes,
        head.hasSnapshot,
      );
    }
    // 手順 4: head の条件付き更新。成功が確定点である。
    await hooks?.beforeCommit?.(aid, seqNr);
    await commitHead(
      resources.head,
      aid,
      prefix,
      seqNr,
      head?.seqNr,
      eventBytes,
      snapshotBytes,
    );
    await hooks?.afterCommit?.(aid, seqNr);
    return Result.ok(prefix);
  });
  if (committed.type === "err") return committed;
  const prefix = committed.value;

  // 手順 5: 新しい末尾を journal へ書き出す。失敗は確定した追記を変えず、別の経路で知らせる。
  try {
    await hooks?.journalWriteTail?.(aid, seqNr);
    await writeJournalRow(
      resources.journal,
      prefix,
      seqNr,
      eventBytes,
      keep === undefined ? undefined : snapshotBytes,
      snapshotBytes !== undefined,
    );
  } catch (cause) {
    await notifyJournalWriteFailure(
      aid,
      seqNr,
      cause,
      settings.logger,
      settings.onJournalWriteFailure,
    );
  }
  if (snapshotBytes !== undefined && keep !== undefined) {
    // BT-13: 整理の失敗は、確定済みの追記の成功を変えず、別の経路で通知する。
    try {
      await retainBigtableHistory(resources, aid, prefix, seqNr, keep);
    } catch (cause) {
      await notifyRetentionFailure(
        aid,
        cause,
        settings.logger,
        settings.onRetentionFailure,
      );
    }
  }
  return Result.ok(undefined);
}
