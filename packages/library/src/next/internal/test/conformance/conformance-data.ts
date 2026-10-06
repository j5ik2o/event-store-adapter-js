import type { ConformanceCase } from "./conformance-case";
import type { ConformanceExclusion } from "./conformance-exclusion";

export type ConformanceData = {
  version: string;
  files: readonly string[];
  exclusions: readonly ConformanceExclusion[];
  cases: readonly ConformanceCase[];
};
