import { EventStoreError } from "../event-store-error";
import type { MemoryStorageInput } from "../memory-storage-input";
import { Result } from "../result";
import { validateSnapshotRetention } from "./snapshot-retention-validation";

export function validateMemoryStorageInput(input?: MemoryStorageInput): Result<
  Readonly<{
    retention: Extract<
      ReturnType<typeof validateSnapshotRetention>,
      { type: "ok" }
    >["value"];
  }>,
  EventStoreError
> {
  let fieldName = "input";
  try {
    if (
      input === null ||
      (input !== undefined &&
        (typeof input !== "object" || Array.isArray(input)))
    ) {
      return Result.err(
        EventStoreError.configuration("input", "input must be an object"),
      );
    }
    fieldName = "retention";
    const inputRetention = input?.retention;
    fieldName = "changeFeed";
    const changeFeed = input?.changeFeed;
    const retention = validateSnapshotRetention(inputRetention);
    if (retention.type === "err") return retention;
    if (retention.value?.mode.type === "ttl") {
      return Result.err(
        EventStoreError.configuration(
          "retention.mode.type",
          "memory storage does not support ttl retention",
        ),
      );
    }
    if (changeFeed !== undefined) {
      return Result.err(
        EventStoreError.configuration(
          "changeFeed",
          "memory storage does not support changeFeed",
        ),
      );
    }
    return Result.ok(Object.freeze({ retention: retention.value }));
  } catch (cause) {
    return Result.err(
      EventStoreError.configuration(
        fieldName,
        "memory storage settings could not be read",
        cause,
      ),
    );
  }
}
