import type { ConformanceAggregateId } from "./conformance-aggregate-id";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceStore } from "./conformance-store";

export interface ConformanceHooks {
  beginOperation?(operation: number): void;
  finishOperation?(operation: number): void;
  evidence?(): unknown;
  checkStorageObservation?(
    observe: ConformanceJsonValue,
    args: ConformanceJsonValue,
    aggregateId?: ConformanceAggregateId,
  ): Promise<void>;
  checkLayout?(layout: ConformanceJsonValue): Promise<void>;
  awaitRetention?(): Promise<void>;
  readHistory?(id: ConformanceAggregateId): Promise<{
    active: readonly bigint[];
    marked: readonly { seqNr: bigint; expires: number }[];
  }>;
  takeRetentionFailures?(): readonly string[];
  setClockEpochSeconds?(s: number): void;
  /** 別の接続が同じファイルの書き込みロックを保持する（SQLite の SQ-7）。 */
  holdWriteLock?(): Promise<void>;
  releaseWriteLock?(): Promise<void>;
  createStore?(request: {
    name: string;
    storage: "new" | "shared";
    sharedWith?: string;
  }): Promise<ConformanceOutcome<ConformanceStore<unknown, unknown>>>;
}
