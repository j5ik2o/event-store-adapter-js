import type { ConformanceAggregateId } from "./conformance-aggregate-id";
import type { ConformanceEventData } from "./conformance-event-data";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceSnapshotData } from "./conformance-snapshot-data";

export interface ConformanceStore<E, S> {
  persistEvent(event: E): Promise<ConformanceOutcome<void>>;
  persistEventAndSnapshot(
    event: E,
    snapshot: S,
  ): Promise<ConformanceOutcome<void>>;
  getLatestSnapshotById(id: ConformanceAggregateId): Promise<
    ConformanceOutcome<
      | { kind: "none" }
      | {
          kind: "snapshot";
          headSeqNr: bigint;
          snapshot: ConformanceSnapshotData | null;
        }
    >
  >;
  getEventsByIdSinceSeqNr(
    id: ConformanceAggregateId,
    seqNr: bigint,
  ): Promise<ConformanceOutcome<readonly ConformanceEventData[]>>;
}
