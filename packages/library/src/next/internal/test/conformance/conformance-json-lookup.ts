import type { ConformanceJsonValue } from "./conformance-json-value";

export function jsonAt(
  value: ConformanceJsonValue | undefined,
  ...path: readonly (string | number)[]
): ConformanceJsonValue | undefined {
  return path.reduce<ConformanceJsonValue | undefined>((node, key) => {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    if (Array.isArray(node)) {
      return typeof key === "number"
        ? (node as readonly ConformanceJsonValue[])[key]
        : undefined;
    }
    const record = node as { readonly [key: string]: ConformanceJsonValue };
    return typeof key === "string" && Object.hasOwn(record, key)
      ? record[key]
      : undefined;
  }, value);
}
