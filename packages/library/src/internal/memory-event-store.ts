import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import { MemoryStorage } from "../memory-storage";
import { Result } from "../result";
import { validateEventStoreInput } from "./event-store-input-validation";
import type { MemoryEventStoreHooks } from "./memory-event-store-hooks";
import {
  commitMemoryStorageRecords,
  readMemoryStorageEvents,
  readMemoryStorageLatestSnapshot,
} from "./memory-storage-records";
import { validateSeqNr } from "./seq-nr-validation";
import {
  validateAggregateId,
  validateEvent,
  validateEventAndSnapshot,
} from "./validated-event-store";

/** 実Storageと保持処理に接続した4操作を返す内部入口。 */
export function createMemoryEventStoreInternal<PE = unknown, PS = unknown>(
  input?: MemoryEventStoreInput<PE, PS>,
  hooks?: MemoryEventStoreHooks,
): Result<EventStore<PE, PS>, EventStoreError> {
  const settings = validateEventStoreInput(input);
  if (settings.type === "err") return settings;
  const {
    eventSerializer: serializer,
    snapshotSerializer,
    logger,
    onRetentionFailure,
  } = settings.value;
  let inputStorage: MemoryStorage | undefined;
  try {
    inputStorage = input?.storage;
  } catch (cause) {
    return Result.err(
      EventStoreError.configuration(
        "storage",
        "storage could not be read",
        cause,
      ),
    );
  }
  const storage =
    inputStorage === undefined
      ? MemoryStorage.create()
      : Result.ok(inputStorage);
  if (storage.type === "err") return storage;
  const retention = Object.freeze({ hooks, logger, onRetentionFailure });

  return Result.ok(
    Object.freeze<EventStore<PE, PS>>({
      async persistEvent(event) {
        const validated = validateEvent(event);
        if (validated.type === "err") return validated;

        let bytes: Uint8Array;
        try {
          bytes = serializer.serialize(validated.value.payload);
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError("serializer.serialize must return Uint8Array");
          }
          bytes = new Uint8Array(bytes);
        } catch (cause) {
          return Result.err(
            EventStoreError.serialization(
              "serialize",
              "event payload serialization failed",
              cause,
            ),
          );
        }

        return commitMemoryStorageRecords(
          storage.value,
          { ...validated.value, payload: bytes },
          undefined,
          hooks?.beforeCommit,
          retention,
        );
      },

      async persistEventAndSnapshot(event, snapshot) {
        const validated = validateEventAndSnapshot(event, snapshot);
        if (validated.type === "err") return validated;

        let eventBytes: Uint8Array;
        try {
          const bytes = serializer.serialize(validated.value.event.payload);
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError("serializer.serialize must return Uint8Array");
          }
          eventBytes = new Uint8Array(bytes);
        } catch (cause) {
          return Result.err(
            EventStoreError.serialization(
              "serialize",
              "event payload serialization failed",
              cause,
            ),
          );
        }

        let snapshotBytes: Uint8Array;
        try {
          const bytes = snapshotSerializer.serialize(
            validated.value.snapshot.aggregate,
          );
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError("serializer.serialize must return Uint8Array");
          }
          snapshotBytes = new Uint8Array(bytes);
        } catch (cause) {
          return Result.err(
            EventStoreError.serialization(
              "serialize",
              "snapshot payload serialization failed",
              cause,
            ),
          );
        }

        return commitMemoryStorageRecords(
          storage.value,
          { ...validated.value.event, payload: eventBytes },
          { ...validated.value.snapshot, aggregate: snapshotBytes },
          hooks?.beforeCommit,
          retention,
        );
      },

      async getLatestSnapshotById(aggregateId) {
        const validatedId = validateAggregateId(aggregateId);
        if (validatedId.type === "err") return validatedId;
        const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;

        const records = await readMemoryStorageLatestSnapshot(
          storage.value,
          aid,
          hooks?.beforeReadSnapshot,
        );
        if (records.type === "err") return records;
        if (records.value === undefined) return Result.ok(undefined);

        try {
          return Result.ok(
            Object.freeze({
              headSeqNr: records.value.headSeqNr,
              snapshot:
                records.value.snapshot === undefined
                  ? undefined
                  : Object.freeze({
                      ...records.value.snapshot,
                      aggregate: snapshotSerializer.deserialize(
                        records.value.snapshot.aggregate,
                        records.value.snapshot.manifest,
                      ),
                    }),
            }),
          );
        } catch (cause) {
          return Result.err(
            EventStoreError.serialization(
              "deserialize",
              "snapshot payload deserialization failed",
              cause,
            ),
          );
        }
      },

      async getEventsByIdSinceSeqNr(aggregateId, seqNr) {
        const validatedId = validateAggregateId(aggregateId);
        if (validatedId.type === "err") return validatedId;
        const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;
        const start = validateSeqNr(seqNr);
        if (start.type === "err") return start;

        const records = await readMemoryStorageEvents(
          storage.value,
          aid,
          start.value,
          hooks?.beforeReadEvents,
        );
        if (records.type === "err") return records;

        try {
          return Result.ok(
            records.value.map((record) =>
              Object.freeze({
                aggregateId: validatedId.value,
                seqNr: record.seqNr,
                occurredAt: new Date(record.occurredAt),
                manifest: record.manifest,
                payload: serializer.deserialize(
                  record.payload,
                  record.manifest,
                ),
              }),
            ),
          );
        } catch (cause) {
          return Result.err(
            EventStoreError.serialization(
              "deserialize",
              "event payload deserialization failed",
              cause,
            ),
          );
        }
      },
    }),
  );
}
