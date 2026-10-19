import type { Snapshot } from "@google-cloud/spanner";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { notifyRetentionFailure } from "./retention-failure-notification";
import { spannerAggregateKey } from "./spanner-aggregate-key";
import type { SpannerEventStoreHooks } from "./spanner-event-store-hooks";
import type { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";
import { runSpannerReadWriteTransaction } from "./spanner-read-write-transaction";
import { spannerRows } from "./spanner-rows";
import { retainSpannerSnapshots } from "./spanner-snapshot-retention";
import { spannerStoredInteger } from "./spanner-stored-integer";
import { SpannerTransactionRejection } from "./spanner-transaction-rejection";
import {
  validateEvent,
  validateEventAndSnapshot,
} from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateSpannerEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

const NANOS_PER_MILLI = BigInt(1000000);
const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

export function createSpannerPersistEvent<PE, PS>(
  settings: Settings<PE, PS>,
  hooks?: SpannerEventStoreHooks,
): EventStore<PE, PS>["persistEvent"] {
  return async (event) => {
    const validated = validateEvent(event);
    if (validated.type === "err") return validated;
    return persistSpannerEvent(settings, validated.value, undefined, hooks);
  };
}

export function createSpannerPersistEventAndSnapshot<PE, PS>(
  settings: Settings<PE, PS>,
  hooks?: SpannerEventStoreHooks,
): EventStore<PE, PS>["persistEventAndSnapshot"] {
  return async (event, snapshot) => {
    const validated = validateEventAndSnapshot(event, snapshot);
    if (validated.type === "err") return validated;
    return persistSpannerEvent(
      settings,
      validated.value.event,
      validated.value.snapshot,
      hooks,
    );
  };
}

function serialize<P>(
  serializer: { serialize(payload: P): Uint8Array },
  payload: P,
  what: string,
): Result<Buffer, EventStoreError> {
  try {
    const serialized = serializer.serialize(payload);
    if (!(serialized instanceof Uint8Array))
      throw new TypeError("serializer.serialize must return Uint8Array");
    return Result.ok(Buffer.from(serialized));
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

async function persistSpannerEvent<PE, PS>(
  settings: Settings<PE, PS>,
  event: EventEnvelope<PE>,
  snapshot: SnapshotEnvelope<PS> | undefined,
  hooks?: SpannerEventStoreHooks,
): Promise<Result<void, EventStoreError>> {
  const { database, tables, retention } = settings;
  const { hashPrefix, aid } = spannerAggregateKey(event.aggregateId);
  const seqNr = event.seqNr;
  const nanos = (
    BigInt(event.occurredAt.getTime()) * NANOS_PER_MILLI
  ).toString();

  const eventBytes = serialize(
    settings.eventSerializer,
    event.payload,
    "event",
  );
  if (eventBytes.type === "err") return eventBytes;
  const snapshotBytes =
    snapshot === undefined
      ? undefined
      : serialize(settings.snapshotSerializer, snapshot.aggregate, "snapshot");
  if (snapshotBytes?.type === "err") return snapshotBytes;

  const key = { hp: hashPrefix, aid };
  const keyTypes = { hp: "bytes", aid: "string" };
  // 試行ごとに同じ封筒・同じ seq_nr で組み立て直す（SPN-7）。
  const result = await runSpannerReadWriteTransaction(
    database,
    settings.transactionRetryLimit,
    async (transaction) => {
      const heads = await spannerRows(
        transaction as Snapshot,
        `SELECT seq_nr FROM \`${tables.head}\` WHERE hash_prefix = @hp AND aid = @aid`,
        key,
        keyTypes,
      );
      let headSeqNr = BigInt(0);
      if (heads.length > 0) {
        const stored = spannerStoredInteger(
          heads[0].seq_nr,
          "head seq_nr",
          BigInt(1),
          MAX_SEQ_NR,
        );
        if (stored.type === "err")
          throw new SpannerTransactionRejection(stored.error);
        headSeqNr = stored.value;
      }
      const next = BigInt(seqNr);
      if (next <= headSeqNr)
        throw new SpannerTransactionRejection(
          EventStoreError.optimisticLockConflict({
            aggregateId: aid,
            seqNr,
            headSeqNr: Number(headSeqNr),
          }),
        );
      if (next !== headSeqNr + BigInt(1))
        throw new SpannerTransactionRejection(
          EventStoreError.contractViolation({ rule: "W-8", seqNr }),
        );

      const row = {
        ...key,
        seq: seqNr.toString(),
        manifest: event.manifest,
        payload: eventBytes.value,
        nanos,
      };
      const rowTypes = {
        ...keyTypes,
        seq: "int64",
        manifest: "string",
        payload: "bytes",
        nanos: "int64",
      };
      const statements: {
        sql: string;
        params: Record<string, unknown>;
        types: Record<string, string>;
      }[] = [
        {
          sql: `INSERT INTO \`${tables.journal}\` (hash_prefix, aid, seq_nr, occurred_at_ns, manifest, payload) VALUES (@hp, @aid, @seq, @nanos, @manifest, @payload)`,
          params: row,
          types: rowTypes,
        },
        headSeqNr === BigInt(0)
          ? {
              sql: `INSERT INTO \`${tables.head}\` (hash_prefix, aid, type_name, seq_nr, event_occurred_at_ns, event_manifest, event_payload) VALUES (@hp, @aid, @type_name, @seq, @nanos, @manifest, @payload)`,
              params: { ...row, type_name: event.aggregateId.typeName },
              types: { ...rowTypes, type_name: "string" },
            }
          : {
              sql: `UPDATE \`${tables.head}\` SET seq_nr = @seq, event_occurred_at_ns = @nanos, event_manifest = @manifest, event_payload = @payload WHERE hash_prefix = @hp AND aid = @aid`,
              params: row,
              types: rowTypes,
            },
      ];
      if (snapshot !== undefined && snapshotBytes !== undefined) {
        const snapshotRow = {
          ...key,
          seq: snapshot.seqNr.toString(),
          manifest: snapshot.manifest,
          payload: snapshotBytes.value,
        };
        const snapshotTypes = {
          ...keyTypes,
          seq: "int64",
          manifest: "string",
          payload: "bytes",
        };
        statements.push({
          sql: `INSERT OR UPDATE \`${tables.snapshotCurrent}\` (hash_prefix, aid, seq_nr, manifest, payload) VALUES (@hp, @aid, @seq, @manifest, @payload)`,
          params: snapshotRow,
          types: snapshotTypes,
        });
        if (retention !== undefined)
          statements.push({
            sql: `INSERT INTO \`${tables.snapshotHistory}\` (hash_prefix, aid, seq_nr, manifest, payload, expired_at) VALUES (@hp, @aid, @seq, @manifest, @payload, NULL)`,
            params: snapshotRow,
            types: snapshotTypes,
          });
      }
      await transaction.batchUpdate(statements as never);
    },
    hooks,
  );
  if (result.type === "err") return result;

  if (snapshot !== undefined && retention !== undefined) {
    // SPN-13: 整理の失敗は、確定済みの追記の成功を変えず、別の経路で通知する。
    const retained = await retainSpannerSnapshots(
      { ...settings, retention },
      { hashPrefix, aid },
      hooks,
    );
    if (retained.type === "err")
      await notifyRetentionFailure(
        aid,
        retained.error,
        settings.logger,
        settings.onRetentionFailure,
      );
  }
  return Result.ok(undefined);
}
