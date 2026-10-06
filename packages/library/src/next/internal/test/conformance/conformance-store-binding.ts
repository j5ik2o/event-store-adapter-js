import type { ConformanceAggregateIdInput } from "./conformance-aggregate-id-input";
import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import type { ConformanceEventData } from "./conformance-event-data";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceSnapshotData } from "./conformance-snapshot-data";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

export interface ConformanceStoreBinding<E, S> {
  readonly backend: ConformanceBackend;
  createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceOutcome<ConformanceCreatedStore<E, S>>>;
  buildAggregateId(
    input: ConformanceAggregateIdInput,
  ): ConformanceOutcome<string>;
  buildEvent(d: ConformanceEventData): ConformanceOutcome<E>;
  buildSnapshot(d: ConformanceSnapshotData): ConformanceOutcome<S>;
}
