import { dynamoDBItemSize } from "./dynamodb-item-size";

test("counts UTF-8 attribute names and strings, raw binary bytes and integer N upper bounds", () => {
  expect(
    dynamoDBItemSize({
      名: { S: "あ🙂" },
      b: { B: new Uint8Array(2) },
      n: { N: "-9223372036854000000" },
    }),
  ).toBe(3 + 1 + 7 + 1 + 1 + 2 + 1 + 1 + 20 + 2);
});

test("includes list/map tags, container overhead and each nested element", () => {
  expect(dynamoDBItemSize({ e: { L: [{ M: { x: { S: "a" } } }] } })).toBe(
    1 + 1 + 3 + 1 + 1 + 3 + 1 + 1 + 1 + 1,
  );
  expect(dynamoDBItemSize({ l: { L: [] }, m: { M: {} } })).toBe(10);
});

test("uses byte length of a binary view rather than the backing buffer or base64 length", () => {
  expect(
    dynamoDBItemSize({ b: { B: new Uint8Array(100).subarray(20, 23) } }),
  ).toBe(5);
});

test("rejects attribute types outside the event item representation", () => {
  expect(() => dynamoDBItemSize({ b: { BOOL: true } })).toThrow(TypeError);
});
