import type { ConformanceAggregateIdInput } from "./conformance-aggregate-id-input";
import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import type { ConformanceEventInput } from "./conformance-event-input";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceSnapshotInput } from "./conformance-snapshot-input";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

export interface ConformanceStoreBinding<E, S> {
  readonly backend: ConformanceBackend;
  createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<E, S>>;
  buildAggregateId(
    input: ConformanceAggregateIdInput,
  ): ConformanceOutcome<string>;
  buildEvent(d: ConformanceEventInput): ConformanceOutcome<E>;
  buildSnapshot(d: ConformanceSnapshotInput): ConformanceOutcome<S>;
  validateSeqNrValue(
    seqNr: bigint,
    context?: "event" | "value",
  ): ConformanceOutcome<bigint>;
}
