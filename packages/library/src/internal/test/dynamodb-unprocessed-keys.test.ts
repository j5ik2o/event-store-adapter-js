import { deferDynamoDBRequestedKeys } from "./dynamodb-unprocessed-keys";

test("uses requested keys, preserves upstream pending keys and leaves inputs unchanged", () => {
  const input = {
    RequestItems: {
      head: { Keys: [{ aid: { S: "Order-1" } }], ConsistentRead: true },
      snapshot: { Keys: [{ aid: { S: "Order-1" }, skey: { N: "0" } }] },
    },
  };
  const upstream = {
    $metadata: {},
    Responses: {
      head: [{ aid: { S: "Order-1" }, seq_nr: { N: "1" } }],
      snapshot: [{ aid: { S: "Order-1" }, skey: { N: "0" } }],
    },
    UnprocessedKeys: { journal: { Keys: [{ aid: { S: "other" } }] } },
  };
  const before = structuredClone({ input, upstream });

  const returned = deferDynamoDBRequestedKeys(input, upstream, ["snapshot"]);

  expect(returned.Responses).toEqual({ head: upstream.Responses.head });
  expect(returned.UnprocessedKeys).toEqual({
    ...upstream.UnprocessedKeys,
    snapshot: { Keys: input.RequestItems.snapshot.Keys },
  });
  expect({ input, upstream }).toEqual(before);
  const key = returned.UnprocessedKeys?.snapshot.Keys?.[0];
  if (key === undefined) throw new Error("expected deferred key");
  key.aid = { S: "changed" };
  expect(input).toEqual(before.input);
});

test.each([
  { RequestItems: undefined },
  { RequestItems: { head: { Keys: [] } } },
])("does not defer absent or empty requested keys %p", (input) => {
  const upstream = { $metadata: {} };
  expect(deferDynamoDBRequestedKeys(input, upstream, ["head"])).toBe(upstream);
});

test("defers actual missing items without inventing responses", () => {
  const input = {
    RequestItems: { head: { Keys: [{ aid: { S: "absent" } }] } },
  };
  const returned = deferDynamoDBRequestedKeys(input, { $metadata: {} }, [
    "head",
  ]);
  expect(returned).toEqual({
    $metadata: {},
    Responses: {},
    UnprocessedKeys: { head: { Keys: input.RequestItems.head.Keys } },
  });
});
