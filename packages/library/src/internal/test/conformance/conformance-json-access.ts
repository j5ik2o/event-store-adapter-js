import type { ConformanceJsonValue } from "./conformance-json-value";

export function recordOf(value: ConformanceJsonValue | undefined) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("conformance object required");
  }
  return value as Readonly<Record<string, ConformanceJsonValue>>;
}

export function listOf(
  value: ConformanceJsonValue | undefined,
): readonly ConformanceJsonValue[] {
  if (!Array.isArray(value)) throw new TypeError("conformance array required");
  return value;
}

export function textOf(value: ConformanceJsonValue | undefined): string {
  if (typeof value !== "string")
    throw new TypeError("conformance string required");
  return value;
}

export function integerOf(value: ConformanceJsonValue | undefined): bigint {
  if (
    typeof value !== "bigint" &&
    (typeof value !== "number" || !Number.isInteger(value))
  ) {
    throw new TypeError("conformance integer required");
  }
  return BigInt(value);
}

export function aggregateIdOf(value: ConformanceJsonValue | undefined) {
  const id = recordOf(value);
  return { typeName: textOf(id.type_name), value: textOf(id.value) };
}
