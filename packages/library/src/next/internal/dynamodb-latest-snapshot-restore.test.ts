import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { PayloadSerializer } from "../payload-serializer";
import { restoreDynamoDBLatestSnapshot } from "./dynamodb-latest-snapshot-restore";

const id = Object.freeze({ typeName: "Order", value: "a-b" });
function head(): Record<string, AttributeValue> {
  return {
    aid: { S: "Order-a-b" },
    type_name: { S: "Order" },
    seq_nr: { N: "1" },
    events: {
      L: [
        {
          M: {
            seq_nr: { N: "1" },
            occurred_at: { N: "0" },
            manifest: { S: "event" },
            payload: { B: new Uint8Array([255]) },
          },
        },
      ],
    },
  };
}
function snapshot(): Record<string, AttributeValue> {
  return {
    aid: { S: "Order-a-b" },
    skey: { N: "0" },
    seq_nr: { N: "2" },
    last_updated_at: { N: "0" },
    manifest: { S: "snapshot/v2" },
    payload: { B: new TextEncoder().encode('{"count":2}') },
  };
}
function without(item: Record<string, AttributeValue>, field: string) {
  return Object.fromEntries(
    Object.entries(item).filter(([name]) => name !== field),
  );
}

test("no head returns undefined even when a current snapshot is present", () => {
  const deserialize = jest.fn();
  expect(
    restoreDynamoDBLatestSnapshot(undefined, snapshot(), id, {
      serialize: jest.fn(),
      deserialize,
    }),
  ).toEqual({ type: "ok", value: undefined });
  expect(deserialize).not.toHaveBeenCalled();
});

test("head-only returns its independent sequence without restoring the head event payload", () => {
  const deserialize = jest.fn();
  const result = restoreDynamoDBLatestSnapshot(head(), undefined, id, {
    serialize: jest.fn(),
    deserialize,
  });
  expect(result).toEqual({ type: "ok", value: { headSeqNr: 1 } });
  if (result.type !== "ok") throw new Error("expected head");
  expect(Object.isFrozen(result.value)).toBe(true);
  expect(deserialize).not.toHaveBeenCalled();
});

test("R-8 accepts a newer snapshot than the independently read head", () => {
  const result = restoreDynamoDBLatestSnapshot(
    head(),
    snapshot(),
    id,
    PayloadSerializer.json(),
  );
  expect(result).toEqual({
    type: "ok",
    value: {
      headSeqNr: 1,
      snapshot: { seqNr: 2, manifest: "snapshot/v2", aggregate: { count: 2 } },
    },
  });
  if (result.type !== "ok") throw new Error("expected snapshot");
  expect(Object.isFrozen(result.value)).toBe(true);
  expect(Object.isFrozen(result.value?.snapshot)).toBe(true);
});

test.each([
  ...["aid", "type_name", "seq_nr", "events"].map((field) => ["head", field]),
  ...["seq_nr", "occurred_at", "manifest", "payload"].map((field) => [
    "event",
    field,
  ]),
  ...["aid", "skey", "seq_nr", "last_updated_at", "manifest", "payload"].map(
    (field) => ["snapshot", field],
  ),
])("missing %s.%s is Storage before snapshot restoration", (target, field) => {
  let h = head();
  let s = snapshot();
  if (target === "head") h = without(h, field);
  if (target === "snapshot") s = without(s, field);
  if (target === "event")
    h = {
      ...h,
      events: {
        L: [
          {
            M: without(
              h.events.L?.[0].M as Record<string, AttributeValue>,
              field,
            ),
          },
        ],
      },
    };
  const deserialize = jest.fn();

  expect(
    restoreDynamoDBLatestSnapshot(h, s, id, {
      serialize: jest.fn(),
      deserialize,
    }),
  ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  expect(deserialize).not.toHaveBeenCalled();
});

test.each<[string, Record<string, AttributeValue>]>([
  ["head", { aid: { N: "1" } }],
  ["head", { aid: { S: "Order-other" } }],
  ["head", { type_name: { S: "Other" } }],
  ["head", { type_name: { N: "1" } }],
  ["head", { seq_nr: { S: "1" } }],
  ["head", { seq_nr: { N: "0" } }],
  ["head", { seq_nr: { N: "9007199254740990.5" } }],
  ["head", { seq_nr: { N: "9007199254740992" } }],
  ["head", { events: { S: "[]" } }],
  ["head", { events: { L: [] } }],
  ["head", { events: { L: [{ NULL: true }] } }],
  ["head", { events: { L: [{ M: {} }, { M: {} }] } }],
  ["event", { seq_nr: { N: "2" } }],
  ["event", { seq_nr: { N: "1.0000000000000001" } }],
  ["event", { occurred_at: { S: "0" } }],
  ["event", { occurred_at: { N: "0.1" } }],
  ["event", { occurred_at: { N: "9223372036854775808" } }],
  ["event", { occurred_at: { N: "-9223372036854775809" } }],
  ["event", { manifest: { NULL: true } }],
  ["event", { payload: { S: "{}" } }],
  ["snapshot", { aid: { N: "1" } }],
  ["snapshot", { aid: { S: "Order-other" } }],
  ["snapshot", { skey: { S: "0" } }],
  ["snapshot", { skey: { N: "1" } }],
  ["snapshot", { skey: { N: "1e-100" } }],
  ["snapshot", { seq_nr: { S: "2" } }],
  ["snapshot", { seq_nr: { N: "-1" } }],
  ["snapshot", { seq_nr: { N: "9007199254740990.5" } }],
  ["snapshot", { seq_nr: { N: "9007199254740992" } }],
  ["snapshot", { last_updated_at: { S: "0" } }],
  ["snapshot", { last_updated_at: { N: "1.0000000000000001" } }],
  ["snapshot", { last_updated_at: { N: "-9223372036856" } }],
  ["snapshot", { last_updated_at: { N: "9223372036855" } }],
  ["snapshot", { manifest: { NULL: true } }],
  ["snapshot", { payload: { S: "{}" } }],
])(
  "invalid saved type, number or consistency in %s %# is Storage",
  (target, patch) => {
    let h = head();
    let s = snapshot();
    if (target === "head") h = { ...h, ...patch };
    if (target === "snapshot") s = { ...s, ...patch };
    if (target === "event")
      h = { ...h, events: { L: [{ M: { ...h.events.L?.[0].M, ...patch } }] } };
    const deserialize = jest.fn();

    expect(
      restoreDynamoDBLatestSnapshot(h, s, id, {
        serialize: jest.fn(),
        deserialize,
      }),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
    expect(deserialize).not.toHaveBeenCalled();
  },
);

test.each([
  ["0e-100", "-9223372036855", 0],
  ["2.0", "9223372036854", 2],
  ["20e-1", "0e100", 2],
  ["9.007199254740991e15", "0", Number.MAX_SAFE_INTEGER],
])(
  "preserves integral snapshot N %s and millisecond boundary %s",
  (raw, millis, expected) => {
    expect(
      restoreDynamoDBLatestSnapshot(
        head(),
        {
          ...snapshot(),
          seq_nr: { N: String(raw) },
          last_updated_at: { N: String(millis) },
        },
        id,
        PayloadSerializer.json(),
      ),
    ).toMatchObject({
      type: "ok",
      value: { headSeqNr: 1, snapshot: { seqNr: expected } },
    });
  },
);

test("head sequence and event sequence compare as exact integers across representations", () => {
  const h = head();
  h.seq_nr = { N: "9.007199254740991e15" };
  const event = h.events.L?.[0].M;
  if (event === undefined) throw new Error("expected head event");
  event.seq_nr = { N: "9007199254740991.0" };
  expect(
    restoreDynamoDBLatestSnapshot(h, undefined, id, PayloadSerializer.json()),
  ).toEqual({ type: "ok", value: { headSeqNr: Number.MAX_SAFE_INTEGER } });
});

test("passes opaque manifest and arbitrary domain value while using saved envelope metadata", () => {
  const domain = {
    seqNr: 99,
    manifest: "domain",
    map: new Map([["value", Symbol("opaque")]]),
    callback: () => BigInt(1),
  };
  const deserialize = jest.fn(() => domain);
  const serialize = jest.fn();
  const result = restoreDynamoDBLatestSnapshot(head(), snapshot(), id, {
    serialize,
    deserialize,
  });
  expect(result).toMatchObject({
    type: "ok",
    value: { snapshot: { seqNr: 2, manifest: "snapshot/v2" } },
  });
  if (result.type !== "ok") throw new Error("expected snapshot");
  expect(result.value?.snapshot?.aggregate).toBe(domain);
  expect(Object.isFrozen(domain)).toBe(false);
  expect(deserialize).toHaveBeenCalledWith(
    new TextEncoder().encode('{"count":2}'),
    "snapshot/v2",
  );
  expect(serialize).not.toHaveBeenCalled();
});

test("deserializer and returned bytes cannot mutate original SDK bytes", () => {
  const stored = snapshot();
  const original = stored.payload.B as Uint8Array;
  const before = new Uint8Array(original);
  const deserialize = jest.fn((bytes: Uint8Array) => {
    bytes[0] = 7;
    return bytes;
  });
  const result = restoreDynamoDBLatestSnapshot(head(), stored, id, {
    serialize: jest.fn(),
    deserialize,
  });
  if (result.type !== "ok" || result.value?.snapshot === undefined)
    throw new Error("expected bytes");
  result.value.snapshot.aggregate.fill(0);
  expect(original).toEqual(before);
  restoreDynamoDBLatestSnapshot(head(), stored, id, {
    serialize: jest.fn(),
    deserialize,
  });
  expect(deserialize.mock.calls[1][0][1]).toBe(before[1]);
});

test("snapshot deserialization errors are Serialization with the original cause", () => {
  const cause = new Error("domain deserialize failed");
  const result = restoreDynamoDBLatestSnapshot(head(), snapshot(), id, {
    serialize: jest.fn(),
    deserialize() {
      throw cause;
    },
  });
  expect(result).toMatchObject({
    type: "err",
    error: { type: "serialization-error", operation: "deserialize" },
  });
  if (result.type !== "err") throw new Error("expected failure");
  expect(result.error.cause).toBe(cause);
});
