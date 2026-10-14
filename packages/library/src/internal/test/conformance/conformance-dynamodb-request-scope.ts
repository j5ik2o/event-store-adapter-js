import assert from "node:assert/strict";
import { listOf, recordOf, textOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";

type Fields = Readonly<Record<string, unknown>>;
type ObservedRequest = Readonly<{
  commandName: string | undefined;
  input: unknown;
}>;

const fieldsOf = (value: unknown, what: string): Fields => {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${what} must be an object`,
  );
  return value as Fields;
};

const arrayOf = (value: unknown, what: string): readonly unknown[] => {
  assert.ok(Array.isArray(value), `${what} must be an array`);
  return value;
};

const aidOfKey = (key: unknown, what: string): unknown[] => {
  const fields = fieldsOf(key, what);
  assert.ok(Object.hasOwn(fields, "aid"), `${what} has no aid`);
  return [fields.aid];
};

const queryAids = (input: Fields): unknown[] => {
  const expression = input.KeyConditionExpression;
  assert.ok(typeof expression === "string", "Query must have a key condition");
  const names = (input.ExpressionAttributeNames ?? {}) as Fields;
  const values = (input.ExpressionAttributeValues ?? {}) as Fields;
  const resolved = expression.replace(/#[A-Za-z0-9_]+/g, (alias) => {
    const name = names[alias];
    assert.ok(typeof name === "string", `unbound attribute name ${alias}`);
    return name;
  });
  const found = resolved.split(/\s+AND\s+/i).flatMap((condition) => {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)\s*$/.exec(
      condition,
    );
    return match !== null && match[1] === "aid" && match[2] !== undefined
      ? [values[match[2]]]
      : [];
  });
  assert.ok(found.length > 0, "Query key condition has no aid equality");
  return found;
};

const requestAids = (api: string, input: Fields): unknown[] => {
  switch (api) {
    case "GetItem":
    case "UpdateItem":
      return aidOfKey(input.Key, `${api} Key`);
    case "BatchGetItem":
      return Object.values(
        fieldsOf(input.RequestItems, "RequestItems"),
      ).flatMap((table) =>
        arrayOf(fieldsOf(table, "BatchGetItem table").Keys, "Keys").flatMap(
          (key) => aidOfKey(key, "BatchGetItem Key"),
        ),
      );
    case "BatchWriteItem":
      return Object.values(
        fieldsOf(input.RequestItems, "RequestItems"),
      ).flatMap((writes) =>
        arrayOf(writes, "BatchWriteItem table").flatMap((write) => {
          const w = fieldsOf(write, "write request");
          return w.PutRequest !== undefined
            ? aidOfKey(
                fieldsOf(w.PutRequest, "PutRequest").Item,
                "PutRequest Item",
              )
            : aidOfKey(
                fieldsOf(w.DeleteRequest, "DeleteRequest").Key,
                "DeleteRequest Key",
              );
        }),
      );
    case "TransactWriteItems":
      return arrayOf(input.TransactItems, "TransactItems").flatMap((entry) => {
        const e = fieldsOf(entry, "transact item");
        if (e.Put !== undefined)
          return aidOfKey(fieldsOf(e.Put, "Put").Item, "Put Item");
        const keyed = e.Update ?? e.Delete ?? e.ConditionCheck;
        return aidOfKey(fieldsOf(keyed, "transact action").Key, "action Key");
      });
    case "Query":
      return queryAids(input);
    default:
      return assert.fail(`unsupported API ${api}`);
  }
};

export function checkDynamoDBRequestScope(
  requests: readonly ObservedRequest[],
  scope: ConformanceJsonValue,
  aggregateAid: string,
): void {
  const declared = recordOf(scope);
  assert.equal(textOf(declared.aid), "aggregate_id", "unsupported aid scope");
  const apis = listOf(declared.apis).map(textOf);
  for (const request of requests) {
    const api = (request.commandName ?? "").replace(/Command$/, "");
    assert.ok(apis.includes(api), `request API ${api} is outside the scope`);
    const aids = requestAids(api, fieldsOf(request.input, `${api} input`));
    assert.ok(aids.length > 0, `${api} reads or writes no aid`);
    for (const aid of aids) {
      const value = fieldsOf(aid, `${api} aid`);
      assert.ok(
        Object.keys(value).length === 1 && value.S === aggregateAid,
        `${api} touches an aid other than ${aggregateAid}`,
      );
    }
  }
}
