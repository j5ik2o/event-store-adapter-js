import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { validateEventStoreInput } from "./event-store-input-validation";
import { validateSnapshotRetention } from "./snapshot-retention-validation";

export function validateDynamoDBEventStoreInput<PE, PS>(
  input: DynamoDBEventStoreInput<PE, PS>,
): Result<
  Readonly<
    DynamoDBEventStoreInput<PE, PS> &
      Extract<
        ReturnType<typeof validateEventStoreInput<PE, PS>>,
        { type: "ok" }
      >["value"] & {
        retention: Extract<
          ReturnType<typeof validateSnapshotRetention>,
          { type: "ok" }
        >["value"];
        retryLimit: number;
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
    fieldName = "client";
    const client = input.client;
    fieldName = "tables";
    const tables = input.tables;
    fieldName = "snapshotAidIndexName";
    const snapshotAidIndexName = input.snapshotAidIndexName;
    fieldName = "retention";
    const inputRetention = input.retention;
    fieldName = "retryLimit";
    const inputRetryLimit = input.retryLimit;
    fieldName = "eventSerializer";
    const eventSerializer = input.eventSerializer;
    fieldName = "snapshotSerializer";
    const snapshotSerializer = input.snapshotSerializer;
    fieldName = "onRetentionFailure";
    const onRetentionFailure = input.onRetentionFailure;
    fieldName = "logger";
    const logger = input.logger;
    fieldName = "client";
    if (
      client === null ||
      typeof client !== "object" ||
      typeof client.send !== "function"
    ) {
      return Result.err(
        EventStoreError.configuration(
          "client",
          "client must have a send method",
        ),
      );
    }
    fieldName = "tables";
    if (
      tables === null ||
      typeof tables !== "object" ||
      Array.isArray(tables)
    ) {
      return Result.err(
        EventStoreError.configuration("tables", "tables must be an object"),
      );
    }
    fieldName = "tables.journal";
    const journal = tables.journal;
    fieldName = "tables.snapshot";
    const snapshot = tables.snapshot;
    fieldName = "tables.head";
    const head = tables.head;
    for (const [nameField, name] of [
      ["tables.journal", journal],
      ["tables.snapshot", snapshot],
      ["tables.head", head],
      ["snapshotAidIndexName", snapshotAidIndexName],
    ] as const) {
      if (typeof name !== "string" || name.length === 0) {
        return Result.err(
          EventStoreError.configuration(
            nameField,
            "name must be a non-empty string",
          ),
        );
      }
    }
    if (journal === snapshot || journal === head || snapshot === head) {
      return Result.err(
        EventStoreError.configuration("tables", "table names must be distinct"),
      );
    }
    const retryLimit = inputRetryLimit === undefined ? 5 : inputRetryLimit;
    if (
      typeof retryLimit !== "number" ||
      !Number.isInteger(retryLimit) ||
      retryLimit < 0
    ) {
      return Result.err(
        EventStoreError.configuration(
          "retryLimit",
          "retryLimit must be a non-negative integer",
        ),
      );
    }
    const retention = validateSnapshotRetention(inputRetention);
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
        client,
        tables: Object.freeze({ journal, snapshot, head }),
        snapshotAidIndexName,
        retention: retention.value,
        retryLimit,
      }),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.configuration(
        fieldName,
        "DynamoDB settings could not be read",
        cause,
      ),
    );
  }
}
