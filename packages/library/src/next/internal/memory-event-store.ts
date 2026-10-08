import { Result } from "../../result";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import { MemoryStorage } from "../memory-storage";
import { validateSerializer } from "./event-store-input-validation";
import {
  commitMemoryStorageRecords,
  readMemoryStorageEvents,
} from "./memory-storage-records";
import { validateSeqNr } from "./seq-nr-validation";
import { validateAggregateId, validateEvent } from "./validated-event-store";

/** 今回接続するイベントの追記と読取を返す内部入口。 */
export function createMemoryEventStoreInternal<PE = unknown>(
  input?: Pick<
    MemoryEventStoreInput<PE, unknown>,
    "storage" | "eventSerializer"
  >,
): Result<
  Pick<EventStore<PE>, "persistEvent" | "getEventsByIdSinceSeqNr">,
  EventStoreError
> {
  if (
    input === null ||
    (input !== undefined && (typeof input !== "object" || Array.isArray(input)))
  ) {
    return Result.err(
      EventStoreError.configuration("input", "input must be an object"),
    );
  }
  const { storage: inputStorage, eventSerializer: inputSerializer } =
    input ?? {};
  const serializer = validateSerializer(inputSerializer, "eventSerializer");
  if (serializer.type === "err") return serializer;
  const storage =
    inputStorage === undefined
      ? MemoryStorage.create()
      : Result.ok(inputStorage);
  if (storage.type === "err") return storage;

  return Result.ok(
    Object.freeze<
      Pick<EventStore<PE>, "persistEvent" | "getEventsByIdSinceSeqNr">
    >({
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
