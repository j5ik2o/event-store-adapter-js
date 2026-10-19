import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SpannerEventStoreInput } from "../spanner-event-store-input";
import { validateEventStoreInput } from "./event-store-input-validation";
import {
  type SpannerTableNames,
  spannerTableNames,
} from "./spanner-table-names";

export type SpannerRetentionSettings = Readonly<{
  count: number;
  mode: { type: "delete" } | { type: "ttl"; graceDays: number };
}>;

const DEFAULT_TRANSACTION_RETRY_LIMIT = 5;

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function validateRetention(
  retention: unknown,
): Result<SpannerRetentionSettings | undefined, EventStoreError> {
  if (retention === undefined) return Result.ok(undefined);
  if (
    retention === null ||
    typeof retention !== "object" ||
    Array.isArray(retention)
  ) {
    return Result.err(
      EventStoreError.configuration("retention", "retention must be an object"),
    );
  }
  const { count, mode } = retention as { count?: unknown; mode?: unknown };
  if (!isPositiveSafeInteger(count)) {
    return Result.err(
      EventStoreError.configuration(
        "retention",
        "retention.count must be a positive integer",
      ),
    );
  }
  if (mode === undefined || mode === "delete") {
    return Result.ok(
      Object.freeze<SpannerRetentionSettings>({
        count,
        mode: { type: "delete" },
      }),
    );
  }
  const graceDays =
    mode !== null && typeof mode === "object"
      ? (mode as { type?: unknown; graceDays?: unknown })
      : undefined;
  if (
    graceDays?.type !== "ttl" ||
    !isPositiveSafeInteger(graceDays.graceDays)
  ) {
    return Result.err(
      EventStoreError.configuration(
        "retention",
        'retention.mode must be "delete" or a ttl with a positive integer graceDays',
      ),
    );
  }
  return Result.ok(
    Object.freeze<SpannerRetentionSettings>({
      count,
      mode: { type: "ttl", graceDays: graceDays.graceDays },
    }),
  );
}

export function validateSpannerEventStoreInput<PE, PS>(
  input: SpannerEventStoreInput<PE, PS>,
): Result<
  Readonly<
    Pick<SpannerEventStoreInput<PE, PS>, "database"> &
      Extract<
        ReturnType<typeof validateEventStoreInput<PE, PS>>,
        { type: "ok" }
      >["value"] & {
        tables: SpannerTableNames;
        retention: SpannerRetentionSettings | undefined;
        transactionRetryLimit: number;
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
    fieldName = "database";
    const database = input.database;
    fieldName = "tablePrefix";
    const tablePrefix = input.tablePrefix;
    fieldName = "changeFeed";
    const changeFeed = input.changeFeed;
    fieldName = "transactionRetryLimit";
    const inputRetryLimit = input.transactionRetryLimit;
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
    if (database === null || typeof database !== "object") {
      return Result.err(
        EventStoreError.configuration("database", "database must be an object"),
      );
    }
    const tables = spannerTableNames(tablePrefix);
    if (tables.type === "err") return tables;
    // SPN-17: 最初の版は変更フィードを提供しない。求める設定は設定エラーにする。
    if (changeFeed !== undefined) {
      return Result.err(
        EventStoreError.configuration(
          "changeFeed",
          "change feed is not supported",
        ),
      );
    }
    const transactionRetryLimit =
      inputRetryLimit === undefined
        ? DEFAULT_TRANSACTION_RETRY_LIMIT
        : inputRetryLimit;
    if (
      typeof transactionRetryLimit !== "number" ||
      !Number.isInteger(transactionRetryLimit) ||
      transactionRetryLimit < 0
    ) {
      return Result.err(
        EventStoreError.configuration(
          "transactionRetryLimit",
          "transactionRetryLimit must be a non-negative integer",
        ),
      );
    }
    const retention = validateRetention(inputRetention);
    if (retention.type === "err") return retention;
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
        database,
        tables: tables.value,
        retention: retention.value,
        transactionRetryLimit,
      }),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.configuration(
        fieldName,
        "Spanner settings could not be read",
        cause,
      ),
    );
  }
}
