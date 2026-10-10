import {
  compareDynamoDBItem,
  declaredItemKey,
  encodeDeclaredItem,
} from "./conformance-dynamodb-items";

const declaration = {
  table: "journal",
  attributes: { aid: "S", seq_nr: "N", payload: "B" },
  values: { aid: "Order-1", seq_nr: "1" },
  binary_json: { payload: { ok: true } },
};

test("seed encoding comes from explicit input and comparison detects complete set, types and JSON values", () => {
  const item = encodeDeclaredItem(declaration);
  expect(declaredItemKey(declaration)).toEqual({
    aid: { S: "Order-1" },
    seq_nr: { N: "1" },
  });
  expect(() => compareDynamoDBItem(declaration, item, new Map())).not.toThrow();
  expect(() =>
    compareDynamoDBItem(
      declaration,
      { ...item, extra: { S: "unexpected" } },
      new Map(),
    ),
  ).toThrow("complete attribute set");
  expect(() =>
    compareDynamoDBItem(
      declaration,
      { ...item, seq_nr: { S: "1" } },
      new Map(),
    ),
  ).toThrow("attribute type");
  expect(() =>
    compareDynamoDBItem(
      declaration,
      { ...item, payload: { B: Buffer.from('{"ok":1}') } },
      new Map(),
    ),
  ).toThrow();
});

test("binds generated ids from real values and checks nested list length and M attributes", () => {
  const bindings = new Map<string, string>();
  const config = {
    attributes: { store_id: "S" },
    values: {},
    bindings: { store_id: "generated-store-id" },
  };
  compareDynamoDBItem(config, { store_id: { S: "real" } }, bindings);
  expect(() =>
    compareDynamoDBItem(config, { store_id: { S: "different" } }, bindings),
  ).toThrow("same generated");
  const spec = {
    attributes: { events: "L" },
    values: { events: [{ seq_nr: "1" }] },
    nested_attributes: { "events[0]": { seq_nr: "N" } },
  };
  compareDynamoDBItem(
    spec,
    { events: { L: [{ M: { seq_nr: { N: "1" } } }] } },
    bindings,
  );
  expect(() =>
    compareDynamoDBItem(spec, { events: { L: [] } }, bindings),
  ).toThrow();
  expect(() =>
    compareDynamoDBItem(
      spec,
      { events: { L: [{ M: { seq_nr: { N: "1" }, extra: { S: "" } } }] } },
      bindings,
    ),
  ).toThrow();
});
