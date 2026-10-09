import type { AttributeValue } from "@aws-sdk/client-dynamodb";

function attributeSize(value: AttributeValue): number {
  // 型タグ1バイトを加え、整数Nは10進表現長+2で可変長の数値容量を上から押さえる。
  if (value.S !== undefined) return 1 + Buffer.byteLength(value.S, "utf8");
  if (value.N !== undefined) return 1 + Buffer.byteLength(value.N, "utf8") + 2;
  if (value.B !== undefined) return 1 + value.B.byteLength;
  if (value.L !== undefined)
    return (
      1 +
      3 +
      value.L.reduce((sum, element) => sum + 1 + attributeSize(element), 0)
    );
  if (value.M !== undefined)
    return (
      1 +
      3 +
      Object.entries(value.M).reduce(
        (sum, [name, element]) =>
          sum + 1 + Buffer.byteLength(name, "utf8") + attributeSize(element),
        0,
      )
    );
  throw new TypeError("event items support only S, N, B, L and M attributes");
}

/** 実項目の属性名、型タグ、生bytes、L/Mの3バイトと要素ごとの1バイトを含む上界。 */
export function dynamoDBItemSize(
  item: Readonly<Record<string, AttributeValue>>,
): number {
  return Object.entries(item).reduce(
    (sum, [name, value]) =>
      sum + Buffer.byteLength(name, "utf8") + attributeSize(value),
    0,
  );
}
