import {
  aggregateIdOf,
  integerOf,
  listOf,
  recordOf,
  textOf,
} from "./conformance-json-access";

test("keeps JSON payloads and exact metadata types distinct", () => {
  expect(recordOf({ payload: 2 })).toEqual({ payload: 2 });
  expect(listOf([true, 1, null])).toEqual([true, 1, null]);
  expect(integerOf(BigInt("9007199254740993"))).toBe(
    BigInt("9007199254740993"),
  );
  expect(integerOf(-1)).toBe(BigInt(-1));
  expect(textOf("é")).toBe("é");
  expect(aggregateIdOf({ type_name: "Order", value: "constructor" })).toEqual({
    typeName: "Order",
    value: "constructor",
  });
});

test("fails at the data boundary for wrong representations", () => {
  expect(() => recordOf(null)).toThrow();
  expect(() => listOf({})).toThrow();
  expect(() => textOf(1)).toThrow();
  expect(() => integerOf(true)).toThrow();
  expect(() => integerOf(1.5)).toThrow();
  expect(() => aggregateIdOf({ type_name: "Order", value: 1 })).toThrow();
});
