import { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";

const database = {} as never;
const base = { database, tablePrefix: "esa" };

test("accepts the minimal input", () => {
  expect(validateSpannerEventStoreInput(base).type).toBe("ok");
});

test("accepts a delete retention and a ttl retention with whole positive days", () => {
  expect(
    validateSpannerEventStoreInput({
      ...base,
      retention: { count: 2, mode: "delete" },
    }).type,
  ).toBe("ok");
  expect(
    validateSpannerEventStoreInput({
      ...base,
      retention: { count: 2, mode: { type: "ttl", graceDays: 7 } },
    }).type,
  ).toBe("ok");
});

test("accepts a transaction retry limit of zero and a positive value", () => {
  for (const transactionRetryLimit of [0, 3]) {
    expect(
      validateSpannerEventStoreInput({ ...base, transactionRetryLimit }).type,
    ).toBe("ok");
  }
});

test.each([
  ["changeFeed with a value", { changeFeed: {} }, "changeFeed"],
  ["changeFeed true", { changeFeed: true }, "changeFeed"],
  [
    "retention count 0",
    { retention: { count: 0, mode: "delete" } },
    "retention",
  ],
  [
    "graceDays 0",
    { retention: { count: 1, mode: { type: "ttl", graceDays: 0 } } },
    "retention",
  ],
  [
    "graceDays -1",
    { retention: { count: 1, mode: { type: "ttl", graceDays: -1 } } },
    "retention",
  ],
  [
    "graceDays 1.5",
    { retention: { count: 1, mode: { type: "ttl", graceDays: 1.5 } } },
    "retention",
  ],
  [
    "negative transactionRetryLimit",
    { transactionRetryLimit: -1 },
    "transactionRetryLimit",
  ],
  [
    "fractional transactionRetryLimit",
    { transactionRetryLimit: 1.5 },
    "transactionRetryLimit",
  ],
])("rejects %s with a configuration error", (_, extra, fieldName) => {
  expect(
    validateSpannerEventStoreInput({ ...base, ...extra } as never),
  ).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName },
  });
});

test("rejects an invalid table prefix", () => {
  expect(
    validateSpannerEventStoreInput({ ...base, tablePrefix: "1esa" }),
  ).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "tablePrefix" },
  });
});

test.each([null, [], "x", 1])("rejects the non-object input %p", (input) => {
  expect(validateSpannerEventStoreInput(input as never)).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "input" },
  });
});

test.each([null, undefined, "db"])("rejects the database %p", (database) => {
  expect(
    validateSpannerEventStoreInput({ ...base, database } as never),
  ).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "database" },
  });
});

test.each([
  null,
  [],
  "ttl",
  5,
  { count: "1" },
  { count: 1, mode: "ttl" },
  { count: 1, mode: 5 },
  { count: 1, mode: null },
  { count: 1, mode: { type: "delete" } },
  { count: 1, mode: { type: "ttl" } },
  { count: 1, mode: { type: "ttl", graceDays: "7" } },
])("rejects the retention %p", (retention) => {
  expect(
    validateSpannerEventStoreInput({ ...base, retention } as never),
  ).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "retention" },
  });
});

test("accepts a retention without a mode as delete", () => {
  expect(
    validateSpannerEventStoreInput({ ...base, retention: { count: 1 } }),
  ).toMatchObject({
    type: "ok",
    value: { retention: { count: 1, mode: { type: "delete" } } },
  });
});

test("reports the field whose getter throws as a configuration error with the cause", () => {
  const cause = new Error("getter");
  const input = {
    database,
    get tablePrefix(): string {
      throw cause;
    },
  };
  expect(validateSpannerEventStoreInput(input as never)).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "tablePrefix", cause },
  });
});

test("rejects an invalid serializer through the common validation", () => {
  expect(
    validateSpannerEventStoreInput({
      ...base,
      eventSerializer: {},
    } as never),
  ).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "eventSerializer" },
  });
});
