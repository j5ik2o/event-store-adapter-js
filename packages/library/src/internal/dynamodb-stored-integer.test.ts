import { dynamoDBStoredInteger } from "./dynamodb-stored-integer";

test.each([
  ["-9223372036854775808", "-9223372036854775808"],
  ["9223372036854775807", "9223372036854775807"],
  ["0001.000", "1"],
  ["1.23e2", "123"],
  ["100e-2", "1"],
  ["-0e100000000000000000000", "0"],
  ["0e-100000000000000000000", "0"],
])("reads integral N %s exactly", (raw, expected) => {
  expect(
    dynamoDBStoredInteger(
      raw,
      "snapshot seq_nr",
      BigInt("-9223372036854775808"),
      BigInt("9223372036854775807"),
    ),
  ).toEqual({ type: "ok", value: BigInt(expected) });
});

test.each([
  undefined,
  "",
  "NaN",
  "0x1",
  "1.0000000000000001",
  "9007199254740990.5",
  "1e-100",
  "1e100",
  "9223372036854775808",
  "-9223372036854775809",
])(
  "rejects malformed, fractional or out of range N %p before Number conversion",
  (raw) => {
    expect(
      dynamoDBStoredInteger(
        raw,
        "snapshot seq_nr",
        BigInt("-9223372036854775808"),
        BigInt("9223372036854775807"),
      ),
    ).toMatchObject({
      type: "err",
      error: { type: "storage-error", message: "invalid snapshot seq_nr" },
    });
  },
);
