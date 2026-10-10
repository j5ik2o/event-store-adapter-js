import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";

const client = new DynamoDBClient({
  region: "ap-northeast-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const send = jest.spyOn(client, "send");
const validInput = {
  client,
  tables: { journal: "journal", snapshot: "snapshot", head: "head" },
  snapshotAidIndexName: "snapshot-aid-index",
};

function validate(input: unknown) {
  return validateDynamoDBEventStoreInput(
    input as DynamoDBEventStoreInput<unknown, unknown>,
  );
}

afterAll(() => {
  send.mockRestore();
  client.destroy();
});

describe("validateDynamoDBEventStoreInput", () => {
  test("defaults retryLimit to five retries and omits history retention", () => {
    const result = validate(validInput);

    expect(result).toMatchObject({
      type: "ok",
      value: { ...validInput, retryLimit: 5, retention: undefined },
    });
    if (result.type !== "ok") throw new Error("expected DynamoDB settings");
    expect(result.value.client).toBe(client);
    const payload = { domainValue: "test" };
    for (const serializer of [
      result.value.eventSerializer,
      result.value.snapshotSerializer,
    ]) {
      expect(
        serializer.deserialize(serializer.serialize(payload), "manifest"),
      ).toEqual(payload);
    }
    expect(send).not.toHaveBeenCalled();
  });

  test("explicit undefined uses the declared defaults", () => {
    expect(
      validate({ ...validInput, retryLimit: undefined, retention: undefined }),
    ).toMatchObject({
      type: "ok",
      value: { retryLimit: 5, retention: undefined },
    });
  });

  test.each([0, 1, 5, Number.MAX_SAFE_INTEGER, 2 ** 53])(
    "accepts retryLimit %p without counting the initial request",
    (retryLimit) => {
      expect(validate({ ...validInput, retryLimit })).toMatchObject({
        type: "ok",
        value: { retryLimit },
      });
    },
  );

  test.each([
    null,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    false,
    BigInt(1),
  ])("rejects invalid retryLimit %p", (retryLimit) => {
    expect(validate({ ...validInput, retryLimit })).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "retryLimit" },
    });
  });

  test.each([undefined, null, false, 0, "settings", []])(
    "rejects invalid or missing input %p",
    (input) => {
      expect(validate(input)).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "input" },
      });
    },
  );

  test.each([
    undefined,
    null,
    false,
    0,
    "client",
    {},
    { send: null },
    { send: 1 },
  ])(
    "rejects missing or invalid client %p without sending an SDK request",
    (invalidClient) => {
      expect(validate({ ...validInput, client: invalidClient })).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "client" },
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, null, false, 0, "tables", []])(
    "rejects missing or invalid tables %p",
    (tables) => {
      expect(validate({ ...validInput, tables })).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "tables" },
      });
    },
  );

  describe.each(["journal", "snapshot", "head"] as const)(
    "tables.%s",
    (table) => {
      test.each([undefined, null, "", 0, false, {}])(
        "rejects missing or invalid table name %p",
        (name) => {
          expect(
            validate({
              ...validInput,
              tables: { ...validInput.tables, [table]: name },
            }),
          ).toMatchObject({
            type: "err",
            error: {
              type: "configuration-error",
              fieldName: `tables.${table}`,
            },
          });
        },
      );
    },
  );

  test.each([
    { journal: "same", snapshot: "same", head: "head" },
    { journal: "same", snapshot: "snapshot", head: "same" },
    { journal: "journal", snapshot: "same", head: "same" },
  ])("rejects each pair of duplicate table names %p", (tables) => {
    expect(validate({ ...validInput, tables })).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "tables" },
    });
  });

  test.each([undefined, null, "", 0, false, {}])(
    "rejects missing or invalid snapshotAidIndexName %p",
    (snapshotAidIndexName) => {
      expect(validate({ ...validInput, snapshotAidIndexName })).toMatchObject({
        type: "err",
        error: {
          type: "configuration-error",
          fieldName: "snapshotAidIndexName",
        },
      });
    },
  );

  test("does not trim names or add restrictions beyond non-empty and distinct", () => {
    const tables = { journal: " ", snapshot: " toString ", head: "__proto__" };
    expect(
      validate({ ...validInput, tables, snapshotAidIndexName: " " }),
    ).toMatchObject({
      type: "ok",
      value: { tables, snapshotAidIndexName: " " },
    });
  });

  test.each([
    { count: 1 },
    { count: 2 ** 53, mode: { type: "delete" } },
    { count: 1, mode: { type: "ttl", graceSeconds: 0 } },
    { count: 1, mode: { type: "ttl", graceSeconds: Number.MAX_SAFE_INTEGER } },
  ])("accepts and normalizes retention %p", (retention) => {
    expect(validate({ ...validInput, retention })).toMatchObject({
      type: "ok",
      value: {
        retention: { ...retention, mode: retention.mode ?? { type: "delete" } },
      },
    });
  });

  test.each([
    [{ count: 0 }, "retention.count"],
    [{ count: 1, mode: { type: "ttl" } }, "retention.mode.graceSeconds"],
    [
      { count: 1, mode: { type: "ttl", graceSeconds: 2 ** 53 } },
      "retention.mode.graceSeconds",
    ],
    [{ count: 1, mode: { type: "other" } }, "retention.mode.type"],
  ])("propagates invalid retention %p", (retention, fieldName) => {
    expect(validate({ ...validInput, retention })).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName },
    });
  });

  test.each([
    "eventSerializer",
    "snapshotSerializer",
    "onRetentionFailure",
    "logger",
  ])("uses the common validator for invalid %s", (fieldName) => {
    expect(validate({ ...validInput, [fieldName]: null })).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("preserves supplied callable references without invoking them", () => {
    const eventSerializer = { serialize: jest.fn(), deserialize: jest.fn() };
    const snapshotSerializer = { serialize: jest.fn(), deserialize: jest.fn() };
    const onRetentionFailure = jest.fn();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const result = validate({
      ...validInput,
      eventSerializer,
      snapshotSerializer,
      onRetentionFailure,
      logger,
    });

    if (result.type !== "ok") throw new Error("expected DynamoDB settings");
    expect(result.value.eventSerializer).toBe(eventSerializer);
    expect(result.value.snapshotSerializer).toBe(snapshotSerializer);
    expect(result.value.onRetentionFailure).toBe(onRetentionFailure);
    expect(result.value.logger).toBe(logger);
    for (const callable of [
      ...Object.values(eventSerializer),
      ...Object.values(snapshotSerializer),
      ...Object.values(logger),
      onRetentionFailure,
      send,
    ]) {
      expect(callable).not.toHaveBeenCalled();
    }
  });

  test("copies and freezes settings without freezing caller objects", () => {
    const input = {
      ...validInput,
      tables: { ...validInput.tables },
      retention: { count: 1, mode: { type: "ttl", graceSeconds: 0 } },
    };
    const result = validate(input);
    if (result.type !== "ok") throw new Error("expected DynamoDB settings");

    input.tables.journal = "changed";
    input.retention.count = 0;
    input.retention.mode.graceSeconds = -1;

    expect(result.value.tables).toEqual(validInput.tables);
    expect(result.value.retention).toEqual({
      count: 1,
      mode: { type: "ttl", graceSeconds: 0 },
    });
    for (const setting of [
      result.value,
      result.value.tables,
      result.value.retention,
      result.value.retention?.mode,
    ]) {
      expect(Object.isFrozen(setting)).toBe(true);
    }
    for (const supplied of [
      input,
      input.tables,
      input.retention,
      input.retention.mode,
      client,
    ]) {
      expect(Object.isFrozen(supplied)).toBe(false);
    }
  });

  test("reads each required setting once and returns the validated values", () => {
    const getters = Object.fromEntries(
      Object.entries(validInput).map(([field, value]) => [
        field,
        jest.fn().mockReturnValueOnce(value).mockReturnValue(null),
      ]),
    );
    const input = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(getters).map(([field, get]) => [field, { get }]),
      ),
    );

    const result = validate(input);

    expect(result).toMatchObject({ type: "ok", value: validInput });
    for (const getter of Object.values(getters)) {
      expect(getter).toHaveBeenCalledTimes(1);
    }
  });
});
