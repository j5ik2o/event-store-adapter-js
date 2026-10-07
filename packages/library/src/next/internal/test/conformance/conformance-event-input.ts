import type { ConformanceAggregateId } from "./conformance-aggregate-id";
import type { ConformanceJsonValue } from "./conformance-json-value";

export type ConformanceEventInput = {
  aggregateId: ConformanceAggregateId;
  seqNr: bigint;
  occurredAtEpochNanos: bigint;
  manifest?: string;
  payload: ConformanceJsonValue;
};
