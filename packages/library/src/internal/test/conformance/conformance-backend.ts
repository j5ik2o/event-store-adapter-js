export type ConformanceBackend =
  | "memory"
  | "dynamodb"
  | "sqlite"
  | "spanner"
  | "bigtable";

export const CONFORMANCE_BACKENDS: readonly ConformanceBackend[] = [
  "memory",
  "dynamodb",
  "sqlite",
  "spanner",
  "bigtable",
];
