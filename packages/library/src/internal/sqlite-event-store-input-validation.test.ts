import { validateSqliteEventStoreInput } from "./sqlite-event-store-input-validation";

const base = { path: "/tmp/store.sqlite3" };

test("accepts the minimal input", () => {
  expect(validateSqliteEventStoreInput(base).type).toBe("ok");
});

test("accepts a delete retention and omitted lockWaitMilliseconds", () => {
  expect(
    validateSqliteEventStoreInput({
      ...base,
      retention: { count: 2, mode: { type: "delete" } },
    }).type,
  ).toBe("ok");
  expect(
    validateSqliteEventStoreInput({ ...base, retention: { count: 1 } }).type,
  ).toBe("ok");
});

test("resolves an omitted lockWaitMilliseconds to the documented default 5000 (SQ-1)", () => {
  expect(validateSqliteEventStoreInput(base)).toMatchObject({
    type: "ok",
    value: { lockWaitMilliseconds: 5000 },
  });
});

test.each([0, 1, 5000, 2147483647])(
  "accepts lockWaitMilliseconds %p",
  (lockWaitMilliseconds) => {
    expect(
      validateSqliteEventStoreInput({ ...base, lockWaitMilliseconds }).type,
    ).toBe("ok");
  },
);

test.each([
  ["an empty path", { path: "" }, "path"],
  ["a non-string path", { path: 1 }, "path"],
  ["a missing path", { path: undefined }, "path"],
  [
    "a negative lockWaitMilliseconds",
    { lockWaitMilliseconds: -1 },
    "lockWaitMilliseconds",
  ],
  [
    "a fractional lockWaitMilliseconds",
    { lockWaitMilliseconds: 1.5 },
    "lockWaitMilliseconds",
  ],
  [
    "lockWaitMilliseconds above 2147483647",
    { lockWaitMilliseconds: 2147483648 },
    "lockWaitMilliseconds",
  ],
  [
    "a NaN lockWaitMilliseconds",
    { lockWaitMilliseconds: Number.NaN },
    "lockWaitMilliseconds",
  ],
  [
    "a string lockWaitMilliseconds",
    { lockWaitMilliseconds: "10" },
    "lockWaitMilliseconds",
  ],
  ["retention count 0", { retention: { count: 0 } }, "retention"],
  ["a fractional retention count", { retention: { count: 1.5 } }, "retention"],
])("rejects %s with a configuration error", (_, extra, fieldName) => {
  expect(
    validateSqliteEventStoreInput({ ...base, ...extra } as never),
  ).toMatchObject({
    type: "err",
    error: {
      type: "configuration-error",
      fieldName:
        fieldName === "retention"
          ? expect.stringMatching(/^retention/)
          : fieldName,
    },
  });
});

test("rejects a ttl retention (SQ-11)", () => {
  expect(
    validateSqliteEventStoreInput({
      ...base,
      retention: { count: 1, mode: { type: "ttl", graceSeconds: 60 } },
    } as never),
  ).toMatchObject({
    type: "err",
    error: {
      type: "configuration-error",
      fieldName: expect.stringMatching(/^retention/),
    },
  });
});

test.each([
  ["true", true],
  ["an object", {}],
  ["false", false],
  ["null", null],
])("rejects changeFeed %s (SQ-20)", (_, changeFeed) => {
  expect(
    validateSqliteEventStoreInput({ ...base, changeFeed } as never),
  ).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "changeFeed" },
  });
});

test("accepts an input without changeFeed even when the key is absent", () => {
  expect("changeFeed" in base).toBe(false);
  expect(validateSqliteEventStoreInput(base).type).toBe("ok");
});
