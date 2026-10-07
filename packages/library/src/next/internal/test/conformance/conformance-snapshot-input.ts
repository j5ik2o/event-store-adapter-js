import type { ConformanceJsonValue } from "./conformance-json-value";

export type ConformanceSnapshotInput = {
  seqNr: bigint;
  manifest?: string;
  aggregate: ConformanceJsonValue;
};
