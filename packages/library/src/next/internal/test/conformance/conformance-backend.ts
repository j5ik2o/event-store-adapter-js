export type ConformanceBackend = "memory" | "dynamodb";

export const CONFORMANCE_BACKENDS: readonly ConformanceBackend[] = [
  "memory",
  "dynamodb",
];
