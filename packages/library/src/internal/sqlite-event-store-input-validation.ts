import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SqliteEventStoreInput } from "../sqlite-event-store-input";
import { validateEventStoreInput } from "./event-store-input-validation";
import { validateSnapshotRetention } from "./snapshot-retention-validation";

const DEFAULT_LOCK_WAIT_MILLISECONDS = 5000;
const MAX_LOCK_WAIT_MILLISECONDS = 2147483647;

export function validateSqliteEventStoreInput<PE, PS>(
  input: SqliteEventStoreInput<PE, PS>,
): Result<
  Readonly<
    Extract<
      ReturnType<typeof validateEventStoreInput<PE, PS>>,
      { type: "ok" }
    >["value"] & {
      path: string;
      lockWaitMilliseconds: number;
      retentionCount: number | undefined;
    }
  >,
  EventStoreError
> {
  let fieldName = "input";
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return Result.err(
        EventStoreError.configuration("input", "input must be an object"),
      );
    }
    fieldName = "path";
    const path = input.path;
    fieldName = "lockWaitMilliseconds";
    const inputLockWait = input.lockWaitMilliseconds;
    fieldName = "changeFeed";
    const changeFeed = input.changeFeed;
    fieldName = "retention";
    const inputRetention = input.retention;
    fieldName = "eventSerializer";
    const eventSerializer = input.eventSerializer;
    fieldName = "snapshotSerializer";
    const snapshotSerializer = input.snapshotSerializer;
    fieldName = "onRetentionFailure";
    const onRetentionFailure = input.onRetentionFailure;
    fieldName = "logger";
    const logger = input.logger;
    if (typeof path !== "string" || path.length === 0) {
      return Result.err(
        EventStoreError.configuration(
          "path",
          "path must be a non-empty string",
        ),
      );
    }
    // SQ-20: 最初の版は変更フィードを提供しない。求める設定は設定エラーにする。
    if (changeFeed !== undefined) {
      return Result.err(
        EventStoreError.configuration(
          "changeFeed",
          "change feed is not supported",
        ),
      );
    }
    const lockWaitMilliseconds =
      inputLockWait === undefined
        ? DEFAULT_LOCK_WAIT_MILLISECONDS
        : inputLockWait;
    if (
      typeof lockWaitMilliseconds !== "number" ||
      !Number.isInteger(lockWaitMilliseconds) ||
      lockWaitMilliseconds < 0 ||
      lockWaitMilliseconds > MAX_LOCK_WAIT_MILLISECONDS
    ) {
      return Result.err(
        EventStoreError.configuration(
          "lockWaitMilliseconds",
          "lockWaitMilliseconds must be an integer from 0 to 2147483647",
        ),
      );
    }
    const retention = validateSnapshotRetention(inputRetention);
    if (retention.type === "err") return retention;
    // SQ-11: 期限切れ方式（TTL）は提供しない。
    if (retention.value?.mode.type === "ttl") {
      return Result.err(
        EventStoreError.configuration(
          "retention.mode.type",
          "sqlite storage does not support ttl retention",
        ),
      );
    }
    const common = validateEventStoreInput({
      eventSerializer,
      snapshotSerializer,
      onRetentionFailure,
      logger,
    });
    if (common.type === "err") return common;
    return Result.ok(
      Object.freeze({
        ...common.value,
        path,
        lockWaitMilliseconds,
        retentionCount: retention.value?.count,
      }),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.configuration(
        fieldName,
        "SQLite settings could not be read",
        cause,
      ),
    );
  }
}
