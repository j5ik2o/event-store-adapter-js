import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { PayloadSerializer } from "../payload-serializer";
import { restoreDynamoDBEventEnvelope } from "./dynamodb-event-envelope-restore";

const aggregateId = Object.freeze({ typeName: "Order", value: "a-b" });
function item(overrides: Record<string, AttributeValue> = {}) {
  return {
    aid: { S: "Order-a-b" },
    seq_nr: { N: "1" },
    occurred_at: { N: "1760000000123000000" },
    manifest: { S: "" },
    payload: { B: new TextEncoder().encode('{"count":1}') },
    ...overrides,
  };
}

test.each(["aid", "seq_nr", "occurred_at", "manifest", "payload"])(
  "missing %s is Storage before payload restoration",
  (field) => {
    const stored = Object.fromEntries(
      Object.entries(item()).filter(([key]) => key !== field),
    );
    const deserialize = jest.fn();
    const result = restoreDynamoDBEventEnvelope(stored, aggregateId, {
      serialize: jest.fn(),
      deserialize,
    });
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(deserialize).not.toHaveBeenCalled();
  },
);

test.each<Record<string, AttributeValue>>([
  { aid: { N: "1" } },
  { aid: { S: "Order-a" } },
  { seq_nr: { S: "1" } },
  { occurred_at: { S: "1" } },
  { manifest: { NULL: true } },
  { payload: { S: "{}" } },
])("invalid attribute type or aid is Storage %#", (overrides) => {
  const deserialize = jest.fn();
  expect(
    restoreDynamoDBEventEnvelope(item(overrides), aggregateId, {
      serialize: jest.fn(),
      deserialize,
    }),
  ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  expect(deserialize).not.toHaveBeenCalled();
});

test.each([
  "0",
  "-1",
  "0.5",
  "9007199254740990.5",
  "9007199254740992",
  "1e-100",
  "1e20",
  "",
  "NaN",
  "0x1",
])("rejects noninteger or out of range seq_nr N %s exactly", (raw) => {
  expect(
    restoreDynamoDBEventEnvelope(
      item({ seq_nr: { N: raw } }),
      aggregateId,
      PayloadSerializer.json(),
    ),
  ).toMatchObject({ type: "err", error: { type: "storage-error" } });
});

test.each([
  "9223372036854775808",
  "-9223372036854775809",
  "9223372036854775807.1",
  "0.1",
  "-0.1",
])("rejects invalid occurred_at N %s before Date rounding", (raw) => {
  expect(
    restoreDynamoDBEventEnvelope(
      item({ occurred_at: { N: raw } }),
      aggregateId,
      PayloadSerializer.json(),
    ),
  ).toMatchObject({ type: "err", error: { type: "storage-error" } });
});

test.each(["1.0", "10e-1"])(
  "restores an integral decimal or exponent N %s without rounding",
  (raw) => {
    expect(
      restoreDynamoDBEventEnvelope(
        item({ seq_nr: { N: raw } }),
        aggregateId,
        PayloadSerializer.json(),
      ),
    ).toMatchObject({ type: "ok", value: { seqNr: 1 } });
  },
);

test.each([
  ["-9223372036854775808", -9223372036855],
  ["9223372036854775807", 9223372036854],
  ["-1", -1],
  ["-1000001", -2],
  ["0e-100", 0],
  ["1.23e8", 123],
])("restores nanos %s with the native Date floor %i", (raw, millis) => {
  const result = restoreDynamoDBEventEnvelope(
    item({
      occurred_at: { N: raw.toString() },
      seq_nr: { N: "9.007199254740991e15" },
    }),
    aggregateId,
    PayloadSerializer.json(),
  );
  expect(result).toEqual({
    type: "ok",
    value: {
      aggregateId,
      seqNr: Number.MAX_SAFE_INTEGER,
      occurredAt: new Date(millis),
      manifest: "",
      payload: { count: 1 },
    },
  });
});

test("passes owned bytes and opaque manifest to the dedicated domain serializer", () => {
  const stored = item({ manifest: { S: "domain/v2" } });
  const domain = new Map([["value", Symbol("opaque")]]);
  const deserialize = jest.fn((bytes: Uint8Array, manifest: string) => {
    expect(manifest).toBe("domain/v2");
    expect(new TextDecoder().decode(bytes)).toBe('{"count":1}');
    bytes.fill(0);
    return domain;
  });
  const serializer = { serialize: jest.fn(), deserialize };
  const first = restoreDynamoDBEventEnvelope(stored, aggregateId, serializer);
  expect(first).toMatchObject({
    type: "ok",
    value: { manifest: "domain/v2", payload: domain },
  });
  expect(new TextDecoder().decode(stored.payload.B)).toBe('{"count":1}');
  if (first.type !== "ok") throw new Error("expected envelope");
  first.value.occurredAt.setTime(0);
  const second = restoreDynamoDBEventEnvelope(stored, aggregateId, serializer);
  expect(second).toMatchObject({
    type: "ok",
    value: { occurredAt: new Date(1760000000123) },
  });
  expect(serializer.serialize).not.toHaveBeenCalled();
});

test("retains the dedicated deserializer cause with Serialization classification", () => {
  const cause = new Error("domain restoration failed");
  const result = restoreDynamoDBEventEnvelope(item(), aggregateId, {
    serialize: jest.fn(),
    deserialize() {
      throw cause;
    },
  });
  expect(result).toMatchObject({
    type: "err",
    error: { type: "serialization-error", operation: "deserialize", cause },
  });
  if (result.type !== "err") throw new Error("expected restoration failure");
  expect(result.error.cause).toBe(cause);
});
