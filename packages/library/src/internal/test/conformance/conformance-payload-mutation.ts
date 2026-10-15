import { isDeepStrictEqual } from "node:util";
import type { ConformanceJsonValue } from "./conformance-json-value";

type Container = Record<string, ConformanceJsonValue> | ConformanceJsonValue[];

const isContainer = (v: unknown): v is Container =>
  typeof v === "object" && v !== null;

// RFC 6901 の JSON Pointer が指す既存の位置を書き換える。
// 試験の目的が「実行器が手元に持つ実体の書き換え」なので、ここだけ破壊的に代入する。
export function mutateConformancePayload(
  payload: ConformanceJsonValue,
  pointer: string,
  value: ConformanceJsonValue | undefined,
): void {
  if (!pointer.startsWith("/"))
    throw new Error(`invalid mutation pointer "${pointer}"`);
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
  const last = tokens[tokens.length - 1];
  let parent: unknown = payload;
  for (const token of tokens.slice(0, -1)) {
    parent = childOf(parent, token, pointer);
  }
  if (!isContainer(parent))
    throw new Error(`mutation position does not exist: ${pointer}`);
  const current = childOf(parent, last, pointer);
  if (isDeepStrictEqual(current, value))
    throw new Error("mutation does not change the value");
  const replacement = structuredClone(value) as ConformanceJsonValue;
  if (Array.isArray(parent)) parent[Number(last)] = replacement;
  else (parent as Record<string, ConformanceJsonValue>)[last] = replacement;
}

const childOf = (parent: unknown, token: string, pointer: string): unknown => {
  const missing = () =>
    new Error(`mutation position does not exist: ${pointer}`);
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9][0-9]*)$/.test(token)) throw missing();
    const index = Number(token);
    if (index >= parent.length) throw missing();
    return parent[index];
  }
  if (isContainer(parent) && Object.hasOwn(parent, token))
    return (parent as Record<string, unknown>)[token];
  throw missing();
};
