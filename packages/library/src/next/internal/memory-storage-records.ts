import { Result } from "../../result";
import { AggregateId } from "../aggregate-id";
import { EventEnvelope } from "../event-envelope";
import { EventStoreError } from "../event-store-error";
import type { MemoryStorage } from "../memory-storage";
import { SnapshotEnvelope } from "../snapshot-envelope";
import type { validateMemoryStorageInput } from "./memory-storage-input-validation";

type Configuration = Extract<
  ReturnType<typeof validateMemoryStorageInput>,
  { type: "ok" }
>["value"];

type StoredEvent = Readonly<{
  aggregateId: string;
  seqNr: number;
  occurredAt: number;
  manifest: string;
  payload: Uint8Array;
}>;

type AggregateRecords = Readonly<{
  head: StoredEvent;
  events: readonly StoredEvent[];
  snapshot: SnapshotEnvelope<Uint8Array> | undefined;
  history: readonly SnapshotEnvelope<Uint8Array>[];
}>;

type StorageState = {
  readonly configuration: Configuration;
  records: ReadonlyMap<string, AggregateRecords>;
  queue: Promise<void>;
};

// ハンドルの寿命に合わせて、保存先ごとの状態だけを非公開で関連付ける。
const states = new WeakMap<MemoryStorage, StorageState>();

export function createMemoryStorageRecords(
  configuration: Configuration,
): MemoryStorage {
  const storage = Object.freeze({}) as MemoryStorage;
  states.set(storage, {
    configuration,
    records: new Map(),
    queue: Promise.resolve(),
  });
  return storage;
}

function stateOf(storage: MemoryStorage): StorageState {
  const state = states.get(storage);
  if (state === undefined) throw new TypeError("unknown memory storage");
  return state;
}

async function withStorageLock<T>(
  state: StorageState,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previous = state.queue;
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function copyEvent(event: StoredEvent): StoredEvent {
  return Object.freeze({ ...event, payload: new Uint8Array(event.payload) });
}

function copySnapshot(
  snapshot: SnapshotEnvelope<Uint8Array>,
): SnapshotEnvelope<Uint8Array> {
  return Object.freeze({
    seqNr: snapshot.seqNr,
    manifest: snapshot.manifest,
    aggregate: new Uint8Array(snapshot.aggregate),
  });
}

/** 検査済みのキーと開始番号で、同じ排他制御内に全件の独立した記録を確保する。 */
export async function readMemoryStorageEvents(
  storage: MemoryStorage,
  aggregateId: string,
  seqNr: number,
): Promise<Result<StoredEvent[], EventStoreError>> {
  try {
    const state = stateOf(storage);
    return await withStorageLock(state, () =>
      Result.ok(
        (state.records.get(aggregateId)?.events ?? [])
          .filter((event) => event.seqNr >= seqNr)
          .map(copyEvent),
      ),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.storage("memory event read failed", cause),
    );
  }
}

/** シリアライザは呼び出し側が所有し、この入口には直列化済み封筒を渡す。 */
export async function commitMemoryStorageRecords(
  storage: MemoryStorage,
  event: EventEnvelope<Uint8Array>,
  snapshot?: SnapshotEnvelope<Uint8Array>,
  beforeCommit?: () => void | Promise<void>,
): Promise<Result<void, EventStoreError>> {
  try {
    const envelope = EventEnvelope.create(event);
    if (envelope.type === "err") return envelope;
    const aggregateId = AggregateId.asString({
      typeName: envelope.value.aggregateId.typeName,
      value: envelope.value.aggregateId.value,
    });
    if (aggregateId.type === "err") return aggregateId;

    let snapshotRecord: SnapshotEnvelope<Uint8Array> | undefined;
    if (snapshot !== undefined) {
      const validatedSnapshot = SnapshotEnvelope.create(snapshot);
      if (validatedSnapshot.type === "err") return validatedSnapshot;
      if (envelope.value.seqNr !== validatedSnapshot.value.seqNr) {
        return Result.err(
          EventStoreError.contractViolation({
            rule: "W-9",
            seqNr: envelope.value.seqNr,
            snapshotSeqNr: validatedSnapshot.value.seqNr,
          }),
        );
      }
      snapshotRecord = copySnapshot(validatedSnapshot.value);
    }
    const eventRecord: StoredEvent = Object.freeze({
      aggregateId: aggregateId.value,
      seqNr: envelope.value.seqNr,
      occurredAt: envelope.value.occurredAt.getTime(),
      manifest: envelope.value.manifest,
      payload: new Uint8Array(envelope.value.payload),
    });

    const state = stateOf(storage);
    return await withStorageLock(state, async () => {
      const current = state.records.get(eventRecord.aggregateId);
      const headSeqNr = current?.head.seqNr ?? 0;
      if (eventRecord.seqNr <= headSeqNr) {
        return Result.err(
          EventStoreError.optimisticLockConflict({
            aggregateId: eventRecord.aggregateId,
            seqNr: eventRecord.seqNr,
            headSeqNr,
          }),
        );
      }
      if (eventRecord.seqNr !== headSeqNr + 1) {
        return Result.err(
          EventStoreError.contractViolation({
            rule: "W-8",
            seqNr: eventRecord.seqNr,
          }),
        );
      }

      const next: AggregateRecords = Object.freeze({
        head: eventRecord,
        events: Object.freeze([...(current?.events ?? []), eventRecord]),
        snapshot: snapshotRecord ?? current?.snapshot,
        history:
          snapshotRecord === undefined ||
          state.configuration.retention === undefined
            ? (current?.history ?? Object.freeze([]))
            : Object.freeze([...(current?.history ?? []), snapshotRecord]),
      });
      const records = new Map(state.records);
      records.set(eventRecord.aggregateId, next);
      await beforeCommit?.();
      // ヘッド・イベント・現在スナップショット・履歴を一度の参照置換で公開する。
      state.records = records;
      return Result.ok(undefined);
    });
  } catch (cause) {
    return Result.err(EventStoreError.storage("memory commit failed", cause));
  }
}

/** 内部確定の検証に使う実記録の観測。保存値への可変な参照は返さない。 */
export async function inspectMemoryStorageRecords(
  storage: MemoryStorage,
): Promise<
  Result<
    Readonly<{
      configuration: Configuration;
      records: ReadonlyMap<string, AggregateRecords>;
    }>,
    EventStoreError
  >
> {
  try {
    const state = stateOf(storage);
    return await withStorageLock(state, () =>
      Result.ok(
        Object.freeze({
          configuration: state.configuration,
          records: new Map(
            [...state.records].map(([aggregateId, record]) => [
              aggregateId,
              Object.freeze({
                head: copyEvent(record.head),
                events: Object.freeze(record.events.map(copyEvent)),
                snapshot:
                  record.snapshot === undefined
                    ? undefined
                    : copySnapshot(record.snapshot),
                history: Object.freeze(record.history.map(copySnapshot)),
              }),
            ]),
          ),
        }),
      ),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.storage("memory inspection failed", cause),
    );
  }
}
