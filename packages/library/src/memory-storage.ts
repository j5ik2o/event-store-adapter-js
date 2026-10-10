import type { EventStoreError } from "./event-store-error";
import { validateMemoryStorageInput } from "./internal/memory-storage-input-validation";
import { createMemoryStorageRecords } from "./internal/memory-storage-records";
import type { MemoryStorageInput } from "./memory-storage-input";
import { Result } from "./result";

declare const memoryStorageBrand: unique symbol;

export type MemoryStorage = Readonly<{ [memoryStorageBrand]: true }>;

export namespace MemoryStorage {
  export function create(
    input?: MemoryStorageInput,
  ): Result<MemoryStorage, EventStoreError> {
    const configuration = validateMemoryStorageInput(input);
    if (configuration.type === "err") return configuration;
    return Result.ok(createMemoryStorageRecords(configuration.value));
  }
}

Object.freeze(MemoryStorage);
