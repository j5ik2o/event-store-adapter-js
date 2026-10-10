import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SnapshotRetention } from "../snapshot-retention";

export function validateSnapshotRetention(retention: unknown): Result<
  | Readonly<{
      count: number;
      mode: Readonly<NonNullable<SnapshotRetention["mode"]>>;
    }>
  | undefined,
  EventStoreError
> {
  let fieldName = "retention";
  try {
    if (retention === undefined) return Result.ok(undefined);
    if (
      retention === null ||
      typeof retention !== "object" ||
      Array.isArray(retention)
    ) {
      return Result.err(
        EventStoreError.configuration(
          "retention",
          "retention must be an object",
        ),
      );
    }
    fieldName = "retention.count";
    const count = (retention as { count?: unknown }).count;
    fieldName = "retention.mode";
    const mode = (retention as { mode?: unknown }).mode;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      return Result.err(
        EventStoreError.configuration(
          "retention.count",
          "retention.count must be an integer of 1 or greater",
        ),
      );
    }
    if (mode === undefined) {
      return Result.ok(
        Object.freeze({
          count,
          mode: Object.freeze({ type: "delete" as const }),
        }),
      );
    }
    if (mode === null || typeof mode !== "object" || Array.isArray(mode)) {
      return Result.err(
        EventStoreError.configuration(
          "retention.mode",
          "retention.mode must be an object",
        ),
      );
    }
    fieldName = "retention.mode.type";
    const { type } = mode as { type?: unknown };
    if (type === "delete") {
      return Result.ok(Object.freeze({ count, mode: Object.freeze({ type }) }));
    }
    if (type === "ttl") {
      fieldName = "retention.mode.graceSeconds";
      const { graceSeconds } = mode as { graceSeconds?: unknown };
      if (
        typeof graceSeconds !== "number" ||
        !Number.isSafeInteger(graceSeconds) ||
        graceSeconds < 0
      ) {
        return Result.err(
          EventStoreError.configuration(
            "retention.mode.graceSeconds",
            "graceSeconds must be a non-negative safe integer",
          ),
        );
      }
      return Result.ok(
        Object.freeze({ count, mode: Object.freeze({ type, graceSeconds }) }),
      );
    }
    return Result.err(
      EventStoreError.configuration(
        "retention.mode.type",
        "retention.mode.type must be delete or ttl",
      ),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.configuration(
        fieldName,
        "retention settings could not be read",
        cause,
      ),
    );
  }
}
