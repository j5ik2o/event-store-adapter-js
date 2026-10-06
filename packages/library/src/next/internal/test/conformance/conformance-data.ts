import type { ConformanceCase } from "./conformance-case";

export type ConformanceData = {
  version: string;
  files: readonly string[];
  cases: readonly ConformanceCase[];
};
