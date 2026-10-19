import { AggregateId } from "../aggregate-id";
import { fnv1a64 } from "./fnv1a64";
import { spannerAggregateKey } from "./spanner-aggregate-key";

const idOf = (typeName: string, value: string): AggregateId => {
  const id = AggregateId.of(typeName, value);
  if (id.type !== "ok") throw new Error("invalid id");
  return id.value;
};

test("embeds the hash as 8 big-endian bytes and keeps the full aid string", () => {
  // "a" のFNV-1a 64 は 0xaf63dc4c8601ec8c。aid は "<typeName>-<value>"
  const key = spannerAggregateKey(idOf("Order", "1"));
  expect(key.aid).toBe("Order-1");
  expect(Buffer.isBuffer(key.hashPrefix)).toBe(true);
  expect(key.hashPrefix).toHaveLength(8);
  expect(key.hashPrefix.readBigUInt64BE(0)).toBe(fnv1a64("Order-1"));
});

test("Order-1 maps to the fixed big-endian bytes of its FNV-1a 64", () => {
  expect(
    spannerAggregateKey(idOf("Order", "1")).hashPrefix.toString("hex"),
  ).toBe("04694b5b07ad70cd");
});

test("different aids with a common prefix produce different keys", () => {
  const first = spannerAggregateKey(idOf("Order", "1"));
  const second = spannerAggregateKey(idOf("Order", "10"));
  expect(first.aid).not.toBe(second.aid);
  expect(first.hashPrefix.equals(second.hashPrefix)).toBe(false);
});
