import assert from "node:assert/strict";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { listOf, recordOf, textOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";

function segments(path: string): string[] {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".");
}

function attributeAt(
  item: Record<string, AttributeValue>,
  path: string,
): AttributeValue {
  const parts = segments(path);
  let attribute = item[parts[0]];
  for (const key of parts.slice(1))
    attribute = /^\d+$/.test(key)
      ? (attribute.L?.[Number(key)] as AttributeValue)
      : (attribute.M?.[key] as AttributeValue);
  assert.ok(attribute, `missing attribute ${path}`);
  return attribute;
}

/** seed と障害宣言の install_items だけを物理入力へ変換する。 */
export function encodeDeclaredItem(
  specification: ConformanceJsonValue,
): Record<string, AttributeValue> {
  const spec = recordOf(specification);
  const binary = recordOf(spec.binary_json ?? {});
  const nested = recordOf(spec.nested_attributes ?? {});
  const encode = (
    attributes: ConformanceJsonValue,
    values: ConformanceJsonValue,
    prefix: string,
  ): Record<string, AttributeValue> =>
    Object.fromEntries(
      Object.entries(recordOf(attributes)).map(([name, type]) => {
        const path = prefix + name;
        const value = recordOf(values)[name];
        switch (type) {
          case "S":
            return [name, { S: textOf(value) }];
          case "N":
            return [name, { N: BigInt(textOf(value)).toString() }];
          case "B": {
            assert.ok(
              Object.hasOwn(binary, path),
              `seed binary input missing: ${path}`,
            );
            return [name, { B: Buffer.from(JSON.stringify(binary[path])) }];
          }
          case "L":
            return [
              name,
              {
                L: listOf(value).map((entry, index) => ({
                  M: encode(
                    nested[`${path}[${index}]`],
                    entry,
                    `${path}[${index}].`,
                  ),
                })),
              },
            ];
          default:
            throw new Error(
              `unsupported declared attribute type ${String(type)}`,
            );
        }
      }),
    );
  assert.equal(
    Object.keys(recordOf(spec.bindings ?? {})).length,
    0,
    "seed must specify actual binding values",
  );
  return encode(spec.attributes, spec.values, "");
}

export function declaredItemKey(
  specification: ConformanceJsonValue,
): Record<string, AttributeValue> {
  const spec = recordOf(specification);
  const values = recordOf(spec.values);
  return {
    aid: { S: textOf(values.aid) },
    ...(spec.table === "journal"
      ? { seq_nr: { N: textOf(values.seq_nr) } }
      : spec.table === "snapshot"
        ? { skey: { N: textOf(values.skey) } }
        : {}),
  };
}

/** 属性集合・型を除外前に検査し、値・binary_json・実値の束縛を別々に比較する。 */
export function compareDynamoDBItem(
  specification: ConformanceJsonValue,
  item: Record<string, AttributeValue> | undefined,
  bindings: Map<string, string>,
): void {
  assert.ok(item, "expected stored item is missing");
  const spec = recordOf(specification);
  const types = (
    actual: Record<string, AttributeValue>,
    expected: ConformanceJsonValue,
  ) => {
    assert.deepEqual(
      Object.keys(actual).sort(),
      Object.keys(recordOf(expected)).sort(),
      "complete attribute set",
    );
    for (const [name, type] of Object.entries(recordOf(expected)))
      assert.deepEqual(
        Object.keys(actual[name]),
        [type],
        `attribute type ${name}`,
      );
  };
  types(item, spec.attributes);
  for (const [path, attributes] of Object.entries(
    recordOf(spec.nested_attributes ?? {}),
  )) {
    const value = attributeAt(item, path);
    assert.ok(value.M, `nested M required at ${path}`);
    assert.deepEqual(Object.keys(value), ["M"]);
    types(value.M, attributes);
  }
  const compareValue = (
    attribute: AttributeValue,
    expected: ConformanceJsonValue,
  ): void => {
    if (attribute.N !== undefined)
      assert.equal(BigInt(attribute.N), BigInt(textOf(expected)));
    else if (attribute.S !== undefined) assert.equal(attribute.S, expected);
    else if (attribute.L !== undefined) {
      const list = listOf(expected);
      assert.equal(attribute.L.length, list.length, "list length");
      attribute.L.forEach((entry, index) => {
        compareValue(entry, list[index]);
      });
    } else if (attribute.M !== undefined) {
      for (const [name, value] of Object.entries(recordOf(expected))) {
        assert.ok(attribute.M[name]);
        compareValue(attribute.M[name], value);
      }
    } else throw new Error("unsupported value comparison");
  };
  for (const [path, expected] of Object.entries(recordOf(spec.values)))
    compareValue(attributeAt(item, path), expected);
  for (const [path, json] of Object.entries(recordOf(spec.binary_json ?? {}))) {
    const binary: Uint8Array | undefined = attributeAt(item, path).B;
    assert.ok(binary, `B required at ${path}`);
    assert.deepEqual(JSON.parse(Buffer.from(binary).toString("utf8")), json);
  }
  for (const [path, binding] of Object.entries(recordOf(spec.bindings ?? {}))) {
    const name = textOf(binding);
    const value: string | undefined = attributeAt(item, path).S;
    assert.ok(
      typeof value === "string" && value.length > 0,
      "generated-store-id must be a nonempty S",
    );
    if (!bindings.has(name)) bindings.set(name, value);
    assert.equal(value, bindings.get(name), "same generated store id");
  }
}
