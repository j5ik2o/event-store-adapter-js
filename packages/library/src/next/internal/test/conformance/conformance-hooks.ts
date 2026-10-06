import type { ConformanceAggregateId } from "./conformance-aggregate-id";

export interface ConformanceHooks {
  awaitRetention?(): Promise<void>;
  readHistory?(id: ConformanceAggregateId): Promise<{
    active: readonly bigint[];
    marked: readonly { seqNr: bigint; expires: number }[];
  }>;
  takeRetentionFailures?(): readonly string[];
  setClockEpochSeconds?(s: number): void;
}
