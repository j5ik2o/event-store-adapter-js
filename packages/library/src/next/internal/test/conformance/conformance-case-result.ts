import type { ConformanceStatus } from "./conformance-status";

export type ConformanceCaseResult = {
  caseId: string;
  rules: readonly string[];
  source: string;
  status: ConformanceStatus;
  reason: string;
  failedOperation?: number;
  expected?: unknown;
  actual?: unknown;
};
