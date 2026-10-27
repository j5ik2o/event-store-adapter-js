import type { BigtableEventStoreInput } from "../bigtable-event-store-input";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { validateEventStoreInput } from "./event-store-input-validation";
import { validateSnapshotRetention } from "./snapshot-retention-validation";

export const DEFAULT_ENVELOPE_LIMIT_BYTES = 1048576;
const MIN_ENVELOPE_LIMIT_BYTES = 17;
const MAX_ENVELOPE_LIMIT_BYTES = 8388608;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export function validateBigtableEventStoreInput<PE, PS>(
  input: BigtableEventStoreInput<PE, PS>,
): Result<
  Readonly<
    Pick<
      BigtableEventStoreInput<PE, PS>,
      "bigtable" | "instanceId" | "accessToken" | "onJournalWriteFailure"
    > &
      Extract<
        ReturnType<typeof validateEventStoreInput<PE, PS>>,
        { type: "ok" }
      >["value"] & {
        tables: Readonly<{ journal: string; head: string }>;
        envelopeLimitBytes: number;
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
    fieldName = "bigtable";
    const bigtable = input.bigtable;
    fieldName = "instanceId";
    const instanceId = input.instanceId;
    fieldName = "tables";
    const tables = input.tables;
    fieldName = "envelopeLimitBytes";
    const inputLimit = input.envelopeLimitBytes;
    fieldName = "changeFeed";
    const changeFeed = input.changeFeed;
    fieldName = "retention";
    const inputRetention = input.retention;
    fieldName = "accessToken";
    const accessToken = input.accessToken;
    fieldName = "onJournalWriteFailure";
    const onJournalWriteFailure = input.onJournalWriteFailure;
    fieldName = "eventSerializer";
    const eventSerializer = input.eventSerializer;
    fieldName = "snapshotSerializer";
    const snapshotSerializer = input.snapshotSerializer;
    fieldName = "onRetentionFailure";
    const onRetentionFailure = input.onRetentionFailure;
    fieldName = "logger";
    const logger = input.logger;
    if (
      bigtable === null ||
      typeof bigtable !== "object" ||
      typeof bigtable.request !== "function"
    ) {
      return Result.err(
        EventStoreError.configuration(
          "bigtable",
          "bigtable must be a Bigtable client",
        ),
      );
    }
    if (!isNonEmptyString(instanceId)) {
      return Result.err(
        EventStoreError.configuration(
          "instanceId",
          "instanceId must be a non-empty string",
        ),
      );
    }
    if (
      tables === null ||
      typeof tables !== "object" ||
      !isNonEmptyString(tables.journal) ||
      !isNonEmptyString(tables.head)
    ) {
      return Result.err(
        EventStoreError.configuration(
          "tables",
          "tables.journal and tables.head must be non-empty strings",
        ),
      );
    }
    if (tables.journal === tables.head) {
      return Result.err(
        EventStoreError.configuration(
          "tables",
          "tables.journal and tables.head must be different tables",
        ),
      );
    }
    // BT-17: 最初の版は変更フィードを提供しない。求める設定は設定エラーにする。
    if (changeFeed !== undefined) {
      return Result.err(
        EventStoreError.configuration(
          "changeFeed",
          "change feed is not supported",
        ),
      );
    }
    const envelopeLimitBytes =
      inputLimit === undefined ? DEFAULT_ENVELOPE_LIMIT_BYTES : inputLimit;
    if (
      typeof envelopeLimitBytes !== "number" ||
      !Number.isInteger(envelopeLimitBytes) ||
      envelopeLimitBytes < MIN_ENVELOPE_LIMIT_BYTES ||
      envelopeLimitBytes > MAX_ENVELOPE_LIMIT_BYTES
    ) {
      return Result.err(
        EventStoreError.configuration(
          "envelopeLimitBytes",
          `envelopeLimitBytes must be an integer from ${MIN_ENVELOPE_LIMIT_BYTES} to ${MAX_ENVELOPE_LIMIT_BYTES}`,
        ),
      );
    }
    const retention = validateSnapshotRetention(inputRetention);
    if (retention.type === "err") return retention;
    // BT-13: 期限切れ方式（TTL）は提供しない。
    if (retention.value?.mode.type === "ttl") {
      return Result.err(
        EventStoreError.configuration(
          "retention.mode.type",
          "bigtable storage does not support ttl retention",
        ),
      );
    }
    // 設定行の読み取りが安全な整数だけを受け付けるので、入力の時点で揃える。
    if (
      retention.value !== undefined &&
      !Number.isSafeInteger(retention.value.count)
    ) {
      return Result.err(
        EventStoreError.configuration(
          "retention.count",
          "retention.count must be a safe integer",
        ),
      );
    }
    if (accessToken !== undefined && typeof accessToken !== "function") {
      return Result.err(
        EventStoreError.configuration(
          "accessToken",
          "accessToken must be a function",
        ),
      );
    }
    if (
      onJournalWriteFailure !== undefined &&
      typeof onJournalWriteFailure !== "function"
    ) {
      return Result.err(
        EventStoreError.configuration(
          "onJournalWriteFailure",
          "onJournalWriteFailure must be a function",
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
        bigtable,
        instanceId,
        tables: Object.freeze({ journal: tables.journal, head: tables.head }),
        envelopeLimitBytes,
        retentionCount: retention.value?.count,
        ...(accessToken !== undefined ? { accessToken } : {}),
        ...(onJournalWriteFailure !== undefined
          ? { onJournalWriteFailure }
          : {}),
      }),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.configuration(
        fieldName,
        "Bigtable settings could not be read",
        cause,
      ),
    );
  }
}
