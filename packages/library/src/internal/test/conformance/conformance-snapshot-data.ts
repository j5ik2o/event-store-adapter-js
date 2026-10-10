import type { ConformanceAggregateId } from "./conformance-aggregate-id";
import type { ConformanceJsonValue } from "./conformance-json-value";

export type ConformanceSnapshotData = {
  aggregateId: ConformanceAggregateId;
  seqNr: bigint;
  manifest: string;
  aggregate: ConformanceJsonValue;
};
