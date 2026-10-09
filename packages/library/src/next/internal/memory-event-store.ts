import { Result } from "../../result";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import { MemoryStorage } from "../memory-storage";
import { validateSerializer } from "./event-store-input-validation";
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

/** 実Storageに接続した4操作を返す内部入口。公開factoryと保持処理は後続。 */
export function createMemoryEventStoreInternal<PE = unknown, PS = unknown>(
  input?: Pick<
    MemoryEventStoreInput<PE, PS>,
    "storage" | "eventSerializer" | "snapshotSerializer"
  >,
): Result<EventStore<PE, PS>, EventStoreError> {
  if (
    input === null ||
    (input !== undefined && (typeof input !== "object" || Array.isArray(input)))
  ) {
    return Result.err(
      EventStoreError.configuration("input", "input must be an object"),
    );
  }
  const {
    storage: inputStorage,
    eventSerializer: inputSerializer,
    snapshotSerializer: inputSnapshotSerializer,
  } = input ?? {};
  const serializer = validateSerializer(inputSerializer, "eventSerializer");
  if (serializer.type === "err") return serializer;
  const snapshotSerializer = validateSerializer(
    inputSnapshotSerializer,
    "snapshotSerializer",
  );
  if (snapshotSerializer.type === "err") return snapshotSerializer;
  const storage =
    inputStorage === undefined
      ? MemoryStorage.create()
      : Result.ok(inputStorage);
  if (storage.type === "err") return storage;

  return Result.ok(
    Object.freeze<EventStore<PE, PS>>({
      async persistEvent(event) {
        const validated = validateEvent(event);
        if (validated.type === "err") return validated;

        let bytes: Uint8Array;
        try {
          bytes = serializer.value.serialize(validated.value.payload);
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError("serializer.serialize must return Uint8Array");
          }
        } catch (cause) {
          return Result.err(
            EventStoreError.serialization(
              "serialize",
              "event payload serialization failed",
              cause,
            ),
          );
        }

        return commitMemoryStorageRecords(storage.value, {
          ...validated.value,
          payload: bytes,
        });
      },

      async persistEventAndSnapshot(event, snapshot) {
        const validated = validateEventAndSnapshot(event, snapshot);
        if (validated.type === "err") return validated;

        let eventBytes: Uint8Array;
        try {
          const bytes = serializer.value.serialize(
            validated.value.event.payload,
          );
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
          const bytes = snapshotSerializer.value.serialize(
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
        );
      },

      async getLatestSnapshotById(aggregateId) {
        const validatedId = validateAggregateId(aggregateId);
        if (validatedId.type === "err") return validatedId;
        const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;

        const records = await readMemoryStorageLatestSnapshot(
          storage.value,
          aid,
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
                      aggregate: snapshotSerializer.value.deserialize(
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
                payload: serializer.value.deserialize(
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
