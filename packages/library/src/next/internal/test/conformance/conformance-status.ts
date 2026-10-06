export type ConformanceStatus =
  | "passed"
  | "failed"
  | "not-applicable"
  | "unverified"
  | "not-representable";

export const CONFORMANCE_STATUSES: readonly ConformanceStatus[] = [
  "passed",
  "failed",
  "not-applicable",
  "unverified",
  "not-representable",
];
