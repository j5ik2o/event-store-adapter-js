import type { ConformanceJsonValue } from "./conformance-json-value";

type JsonRecord = { readonly [key: string]: ConformanceJsonValue };

const isRecord = (v: ConformanceJsonValue | undefined): v is JsonRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isList = (
  v: ConformanceJsonValue | undefined,
): v is readonly ConformanceJsonValue[] => Array.isArray(v);

const child = (
  node: ConformanceJsonValue,
  segment: string,
): ConformanceJsonValue | undefined => {
  if (isRecord(node)) {
    return Object.hasOwn(node, segment) ? node[segment] : undefined;
  }
  if (isList(node) && /^(0|[1-9]\d*)$/.test(segment)) {
    return node[Number(segment)];
  }
  return undefined;
};

const replaceAt = (
  node: ConformanceJsonValue,
  segments: readonly string[],
  replacement: string,
): ConformanceJsonValue => {
  if (segments.length === 0) {
    return replacement;
  }
  const [head, ...tail] = segments;
  const next = child(node, head) as ConformanceJsonValue;
  const updated = replaceAt(next, tail, replacement);
  if (isList(node)) {
    return node.map((item, i) => (i === Number(head) ? updated : item));
  }
  return { ...(node as JsonRecord), [head]: updated };
};

const decodePointer = (pointer: string): readonly string[] =>
  pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

const expandOne = (
  body: ConformanceJsonValue,
  generator: ConformanceJsonValue,
): ConformanceJsonValue => {
  if (
    !isRecord(generator) ||
    typeof generator.target !== "string" ||
    typeof generator.character !== "string" ||
    typeof generator.byte_length !== "number"
  ) {
    throw new Error("invalid generator entry");
  }
  const { target, character, byte_length: byteLength } = generator;
  if (!target.startsWith("/")) {
    throw new Error(`generator target must start with '/': ${target}`);
  }
  const segments = decodePointer(target);
  const current = segments.reduce<ConformanceJsonValue | undefined>(
    (node, segment) => (node === undefined ? undefined : child(node, segment)),
    body,
  );
  if (current !== "") {
    throw new Error(`generator target is not an empty string: ${target}`);
  }
  if ([...character].length !== 1) {
    throw new Error(`generator character must be one character: ${character}`);
  }
  const width = Buffer.byteLength(character, "utf8");
  if (!Number.isInteger(byteLength) || byteLength % width !== 0) {
    throw new Error(
      `generator byte_length ${byteLength} is not a multiple of ${width}`,
    );
  }
  return replaceAt(body, segments, character.repeat(byteLength / width));
};

export function expandGenerators(
  caseBody: ConformanceJsonValue,
): ConformanceJsonValue {
  if (!isRecord(caseBody) || caseBody.generators === undefined) {
    return caseBody;
  }
  const generators = caseBody.generators;
  if (!isList(generators)) {
    throw new Error("generators must be an array");
  }
  const targets = generators.map((g) => (isRecord(g) ? g.target : undefined));
  if (new Set(targets).size !== targets.length) {
    throw new Error("generators contain the same target twice");
  }
  return generators.reduce<ConformanceJsonValue>(expandOne, caseBody);
}
