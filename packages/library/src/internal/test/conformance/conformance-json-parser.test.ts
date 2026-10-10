import { parseConformanceJson } from "./conformance-json-parser";

const never = () => false;
const always = () => true;

describe("parseConformanceJson", () => {
  test("rejects duplicate keys nested inside objects with source and pointer", () => {
    expect(() =>
      parseConformanceJson('{"a":{"b":1,"b":2}}', "dup.json", never),
    ).toThrow(/dup\.json.*\/a/);
  });

  test("reads an integer above 2^53 exactly as bigint when the path is a bigint path", () => {
    const value = parseConformanceJson(
      '{"n":9007199254740993}',
      "big.json",
      always,
    ) as { n: unknown };
    expect(value.n).toBe(BigInt("9007199254740993"));
  });

  test("keeps numbers as number when the path is not a bigint path", () => {
    const value = parseConformanceJson('{"n":5}', "num.json", never) as {
      n: unknown;
    };
    expect(value.n).toBe(5);
  });

  test("rejects NaN", () => {
    expect(() => parseConformanceJson("[NaN]", "nan.json", never)).toThrow(
      "nan.json",
    );
  });

  test("rejects trailing garbage", () => {
    expect(() => parseConformanceJson("{} x", "tail.json", never)).toThrow(
      "tail.json",
    );
  });

  test("rejects raw control characters in strings", () => {
    expect(() =>
      parseConformanceJson('["a\u0001b"]', "ctl.json", never),
    ).toThrow("ctl.json");
  });

  test("decodes unicode escapes", () => {
    expect(parseConformanceJson('["\\u3042"]', "u.json", never)).toEqual([
      "あ",
    ]);
  });

  test.each([
    ["1.0", "1"],
    ["1e3", "1000"],
    ["1.50e1", "15"],
    ["10e-1", "1"],
    ["9007199254740993.0", "9007199254740993"],
  ])("reads %s as the integer %s on a bigint path", (text, expected) => {
    const value = parseConformanceJson(`{"n":${text}}`, "int.json", always) as {
      n: unknown;
    };
    expect(value.n).toBe(BigInt(expected));
  });

  test.each(["1.5", "1e-1", "1e5000"])(
    "rejects %s on a bigint path",
    (text) => {
      expect(() =>
        parseConformanceJson(`{"n":${text}}`, "frac.json", always),
      ).toThrow("expected an integer");
    },
  );
});
