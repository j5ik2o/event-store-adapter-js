import { Result } from "../../result";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import { EventStoreError } from "../event-store-error";
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
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return Result.err(
      EventStoreError.configuration("input", "input must be an object"),
    );
  }
  const {
    client,
    tables,
    snapshotAidIndexName,
    retention: inputRetention,
    retryLimit: inputRetryLimit,
    eventSerializer,
    snapshotSerializer,
    onRetentionFailure,
    logger,
  } = input;
  if (
    client === null ||
    typeof client !== "object" ||
    typeof client.send !== "function"
  ) {
    return Result.err(
      EventStoreError.configuration("client", "client must have a send method"),
    );
  }
  if (tables === null || typeof tables !== "object" || Array.isArray(tables)) {
    return Result.err(
      EventStoreError.configuration("tables", "tables must be an object"),
    );
  }
  const { journal, snapshot, head } = tables;
  for (const [fieldName, name] of [
    ["tables.journal", journal],
    ["tables.snapshot", snapshot],
    ["tables.head", head],
    ["snapshotAidIndexName", snapshotAidIndexName],
  ] as const) {
    if (typeof name !== "string" || name.length === 0) {
      return Result.err(
        EventStoreError.configuration(
          fieldName,
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
}
