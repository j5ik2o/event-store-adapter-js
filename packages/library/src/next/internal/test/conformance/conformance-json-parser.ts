import type { ConformanceJsonValue } from "./conformance-json-value";

export type JsonPath = readonly (string | number)[];

const NUMBER_PATTERN = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const MAX_EXPONENT_SHIFT = 1000;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

// 10 進表記の文字列から BigInt で正確に整数値を求める。整数にならなければ undefined。
const exactInteger = (match: RegExpExecArray): bigint | undefined => {
  const negative = match[0].startsWith("-");
  const intPart = match[1];
  const fraction = (match[2] ?? "").slice(1);
  const exponent = match[3] === undefined ? 0 : Number(match[3].slice(1));
  const mantissa = BigInt(intPart + fraction);
  const shift = exponent - fraction.length;
  if (mantissa === BigInt(0)) {
    return BigInt(0);
  }
  // 桁数が極端な指数は、メモリを使い切る前に拒む（整数としては扱わない）。
  if (Math.abs(shift) > MAX_EXPONENT_SHIFT) {
    return undefined;
  }
  const unit = BigInt(`1${"0".repeat(Math.abs(shift))}`);
  const magnitude =
    shift >= 0
      ? mantissa * unit
      : mantissa % unit === BigInt(0)
        ? mantissa / unit
        : undefined;
  return magnitude === undefined
    ? undefined
    : negative
      ? -magnitude
      : magnitude;
};

const formatPointer = (path: JsonPath): string =>
  path.length === 0
    ? "(root)"
    : path
        .map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`)
        .join("");

export function parseConformanceJson(
  text: string,
  source: string,
  isBigIntPath: (path: JsonPath) => boolean,
): ConformanceJsonValue {
  // 位置を進める局所的な状態。関数の外へは漏れない。
  let pos = 0;

  const fail = (reason: string, path: JsonPath): never => {
    throw new Error(`${source}: ${reason} at ${formatPointer(path)}`);
  };

  const skipWhitespace = (): void => {
    while (pos < text.length && " \t\n\r".includes(text.charAt(pos))) {
      pos += 1;
    }
  };

  const expect = (ch: string, path: JsonPath): void => {
    if (text.charAt(pos) !== ch) {
      fail(`expected '${ch}'`, path);
    }
    pos += 1;
  };

  const parseString = (path: JsonPath): string => {
    expect('"', path);
    let result = "";
    for (;;) {
      if (pos >= text.length) {
        return fail("unterminated string", path);
      }
      const ch = text.charAt(pos);
      pos += 1;
      if (ch === '"') {
        return result;
      }
      if (ch.charCodeAt(0) < 0x20) {
        return fail("control character in string", path);
      }
      if (ch !== "\\") {
        result += ch;
        continue;
      }
      const esc = text.charAt(pos);
      pos += 1;
      if (esc === "u") {
        const hex = text.slice(pos, pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return fail("invalid unicode escape", path);
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        pos += 4;
      } else if (Object.hasOwn(ESCAPES, esc)) {
        result += ESCAPES[esc];
      } else {
        return fail("invalid escape", path);
      }
    }
  };

  const parseNumber = (path: JsonPath): number | bigint => {
    NUMBER_PATTERN.lastIndex = pos;
    const match = NUMBER_PATTERN.exec(text);
    if (match === null) {
      return fail("invalid number", path);
    }
    pos += match[0].length;
    if (isBigIntPath(path)) {
      const integer = exactInteger(match);
      return integer === undefined
        ? fail("expected an integer", path)
        : integer;
    }
    const n = Number(match[0]);
    if (!Number.isFinite(n)) {
      return fail("number is not finite", path);
    }
    return n;
  };

  const parseArray = (path: JsonPath): ConformanceJsonValue => {
    expect("[", path);
    skipWhitespace();
    if (text.charAt(pos) === "]") {
      pos += 1;
      return [];
    }
    const items: ConformanceJsonValue[] = [];
    for (;;) {
      items.push(parseValue([...path, items.length]));
      skipWhitespace();
      const ch = text.charAt(pos);
      pos += 1;
      if (ch === "]") {
        return items;
      }
      if (ch !== ",") {
        return fail("expected ',' or ']'", path);
      }
    }
  };

  const parseObject = (path: JsonPath): ConformanceJsonValue => {
    expect("{", path);
    skipWhitespace();
    if (text.charAt(pos) === "}") {
      pos += 1;
      return {};
    }
    const entries: [string, ConformanceJsonValue][] = [];
    const keys = new Set<string>();
    for (;;) {
      skipWhitespace();
      const key = parseString(path);
      if (keys.has(key)) {
        fail("duplicate key", [...path, key]);
      }
      keys.add(key);
      skipWhitespace();
      expect(":", [...path, key]);
      entries.push([key, parseValue([...path, key])]);
      skipWhitespace();
      const ch = text.charAt(pos);
      pos += 1;
      if (ch === "}") {
        return Object.fromEntries(entries);
      }
      if (ch !== ",") {
        return fail("expected ',' or '}'", path);
      }
    }
  };

  const parseLiteral = (
    literal: string,
    value: ConformanceJsonValue,
    path: JsonPath,
  ): ConformanceJsonValue => {
    if (!text.startsWith(literal, pos)) {
      return fail("unexpected token", path);
    }
    pos += literal.length;
    return value;
  };

  function parseValue(path: JsonPath): ConformanceJsonValue {
    skipWhitespace();
    const ch = text.charAt(pos);
    if (ch === "{") {
      return parseObject(path);
    }
    if (ch === "[") {
      return parseArray(path);
    }
    if (ch === '"') {
      return parseString(path);
    }
    if (ch === "t") {
      return parseLiteral("true", true, path);
    }
    if (ch === "f") {
      return parseLiteral("false", false, path);
    }
    if (ch === "n") {
      return parseLiteral("null", null, path);
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return parseNumber(path);
    }
    return fail("unexpected token", path);
  }

  const value = parseValue([]);
  skipWhitespace();
  if (pos < text.length) {
    fail("unexpected trailing characters", []);
  }
  return value;
}
