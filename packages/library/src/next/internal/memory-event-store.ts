import { Result } from "../../result";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import { MemoryStorage } from "../memory-storage";
import { validateSerializer } from "./event-store-input-validation";
import { commitMemoryStorageRecords } from "./memory-storage-records";
import { validateEvent } from "./validated-event-store";

/** 今回接続する persistEvent だけを返す内部入口。 */
export function createMemoryEventStoreInternal<PE = unknown>(
  input?: Pick<
    MemoryEventStoreInput<PE, unknown>,
    "storage" | "eventSerializer"
  >,
): Result<Pick<EventStore<PE>, "persistEvent">, EventStoreError> {
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
    Object.freeze<Pick<EventStore<PE>, "persistEvent">>({
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
    }),
  );
}
