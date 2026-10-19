import { spannerStoredInteger } from "./spanner-stored-integer";

const MAX = BigInt("9007199254740991");

test("restores the upper-bound seq_nr without loss from the wrapped INT64", () => {
  expect(
    spannerStoredInteger(
      { value: "9007199254740991" },
      "seq_nr",
      BigInt(1),
      MAX,
    ),
  ).toEqual({ type: "ok", value: MAX });
});

test.each([
  ["a plain decimal string", "42", BigInt(42)],
  ["a bigint", BigInt(7), BigInt(7)],
  ["a wrapped string", { value: "1" }, BigInt(1)],
])("restores %s", (_, raw, expected) => {
  expect(spannerStoredInteger(raw, "seq_nr", BigInt(1), MAX)).toEqual({
    type: "ok",
    value: expected,
  });
});

test("restores a negative INT64 when the range allows it", () => {
  expect(
    spannerStoredInteger(
      { value: "-9223372036854775808" },
      "occurred_at_ns",
      BigInt("-9223372036854775808"),
      BigInt("9223372036854775807"),
    ),
  ).toEqual({ type: "ok", value: BigInt("-9223372036854775808") });
});

test.each([
  "9007199254740992",
  "0",
  "1.5",
  "",
  "abc",
  { value: "9007199254740992" },
  undefined,
  null,
  1.5,
])("rejects %p as a storage error without rounding through number", (raw) => {
  expect(spannerStoredInteger(raw, "seq_nr", BigInt(1), MAX)).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
});
