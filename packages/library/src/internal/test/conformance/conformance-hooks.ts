import type { ConformanceAggregateId } from "./conformance-aggregate-id";
import type { ConformanceJsonValue } from "./conformance-json-value";

export interface ConformanceHooks {
  beginOperation?(operation: number): void;
  finishOperation?(operation: number): void;
  evidence?(): unknown;
  checkStorageObservation?(
    observe: ConformanceJsonValue,
    args: ConformanceJsonValue,
  ): Promise<void>;
  checkLayout?(layout: ConformanceJsonValue): Promise<void>;
  awaitRetention?(): Promise<void>;
  readHistory?(id: ConformanceAggregateId): Promise<{
    active: readonly bigint[];
    marked: readonly { seqNr: bigint; expires: number }[];
  }>;
  takeRetentionFailures?(): readonly string[];
  setClockEpochSeconds?(s: number): void;
}
