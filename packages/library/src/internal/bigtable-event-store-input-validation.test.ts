import { validateBigtableEventStoreInput } from "./bigtable-event-store-input-validation";

const bigtable = { request: jest.fn() } as never;
const base = {
  bigtable,
  instanceId: "inst",
  tables: { journal: "journal", head: "head" },
};

test("accepts the minimal input and the documented limits", () => {
  expect(validateBigtableEventStoreInput(base).type).toBe("ok");
  for (const envelopeLimitBytes of [17, 1048576, 8388608]) {
    expect(
      validateBigtableEventStoreInput({ ...base, envelopeLimitBytes }).type,
    ).toBe("ok");
  }
  expect(
    validateBigtableEventStoreInput({ ...base, retention: { count: 2 } }).type,
  ).toBe("ok");
  expect(
    validateBigtableEventStoreInput({ ...base, accessToken: () => "t" }).type,
  ).toBe("ok");
});

test.each([
  [
    "a ttl retention",
    { retention: { count: 1, mode: { type: "ttl", graceSeconds: 604800 } } },
    "retention.mode.type",
  ],
  ["a retention count of 0", { retention: { count: 0 } }, "retention.count"],
  [
    "a retention count of 2^53",
    { retention: { count: 2 ** 53 } },
    "retention.count",
  ],
  ["a change feed", { changeFeed: {} }, "changeFeed"],
  [
    "an envelope limit below 17",
    { envelopeLimitBytes: 16 },
    "envelopeLimitBytes",
  ],
  [
    "an envelope limit above 8 MiB",
    { envelopeLimitBytes: 8388609 },
    "envelopeLimitBytes",
  ],
  [
    "a fractional envelope limit",
    { envelopeLimitBytes: 1024.5 },
    "envelopeLimitBytes",
  ],
  [
    "the same table for journal and head",
    { tables: { journal: "t", head: "t" } },
    "tables",
  ],
  [
    "an accessToken that is not a function",
    { accessToken: "token" },
    "accessToken",
  ],
])(
  "rejects %s as a configuration error naming the field",
  (_name, over, field) => {
    const result = validateBigtableEventStoreInput({
      ...base,
      ...over,
    } as never);
    expect(result.type).toBe("err");
    if (result.type === "err") {
      expect(result.error).toMatchObject({
        type: "configuration-error",
        fieldName: field,
      });
    }
  },
);

test("never sends a request while validating", () => {
  const request = jest.fn();
  validateBigtableEventStoreInput({
    ...base,
    bigtable: { request } as never,
    changeFeed: true,
  });
  expect(request).not.toHaveBeenCalled();
});

describe("input shape errors", () => {
  test.each([
    ["null input", null, "input"],
    ["array input", [], "input"],
    ["a missing client", { ...base, bigtable: undefined }, "bigtable"],
    ["a null client", { ...base, bigtable: null }, "bigtable"],
    ["a client without request()", { ...base, bigtable: {} }, "bigtable"],
    ["an empty instanceId", { ...base, instanceId: "" }, "instanceId"],
    ["a numeric instanceId", { ...base, instanceId: 1 }, "instanceId"],
    ["missing tables", { ...base, tables: undefined }, "tables"],
    ["null tables", { ...base, tables: null }, "tables"],
    [
      "an empty journal table",
      { ...base, tables: { journal: "", head: "h" } },
      "tables",
    ],
    [
      "a numeric head table",
      { ...base, tables: { journal: "j", head: 1 } },
      "tables",
    ],
    [
      "a retention that is not an object",
      { ...base, retention: "x" },
      "retention",
    ],
    [
      "an onJournalWriteFailure that is not a function",
      { ...base, onJournalWriteFailure: 1 },
      "onJournalWriteFailure",
    ],
    [
      "an eventSerializer without methods",
      { ...base, eventSerializer: {} },
      "eventSerializer",
    ],
    [
      "an onRetentionFailure that is not a function",
      { ...base, onRetentionFailure: 1 },
      "onRetentionFailure",
    ],
  ])(
    "rejects %s as a configuration error naming the field",
    (_name, input, field) => {
      const result = validateBigtableEventStoreInput(input as never);
      expect(result).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: field },
      });
    },
  );

  test("a getter that throws is reported as a configuration error naming the field", () => {
    const input = { ...base };
    Object.defineProperty(input, "instanceId", {
      get(): string {
        throw new Error("boom");
      },
    });
    expect(validateBigtableEventStoreInput(input)).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "instanceId" },
    });
  });

  test("keeps the optional callbacks it validated", () => {
    const onJournalWriteFailure = () => undefined;
    const accessToken = () => "t";
    const result = validateBigtableEventStoreInput({
      ...base,
      accessToken,
      onJournalWriteFailure,
    });
    expect(result.type === "ok" && result.value.onJournalWriteFailure).toBe(
      onJournalWriteFailure,
    );
    expect(result.type === "ok" && result.value.accessToken).toBe(accessToken);
    expect(result.type === "ok" && result.value.envelopeLimitBytes).toBe(
      1048576,
    );
  });
});
