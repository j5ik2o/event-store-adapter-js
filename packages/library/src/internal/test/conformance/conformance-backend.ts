export type ConformanceBackend = "memory" | "dynamodb" | "spanner";

export const CONFORMANCE_BACKENDS: readonly ConformanceBackend[] = [
  "memory",
  "dynamodb",
  "spanner",
];

// この言語が提供しない保存先（SQLite・Bigtable）だけを対象とする場面か
export function targetsOnlyUnprovidedBackends(backends: unknown): boolean {
  return (
    Array.isArray(backends) &&
    backends.length > 0 &&
    !backends.some((b) =>
      CONFORMANCE_BACKENDS.includes(b as ConformanceBackend),
    )
  );
}
