import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceEventData } from "./conformance-event-data";
import type { ConformanceHooks } from "./conformance-hooks";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceSnapshotData } from "./conformance-snapshot-data";
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreConfig } from "./conformance-store-config";

export interface ConformanceStoreBinding<E, S> {
  readonly backend: ConformanceBackend;
  createStore(config: ConformanceStoreConfig): Promise<
    ConformanceOutcome<{
      store: ConformanceStore<E, S>;
      hooks: ConformanceHooks;
    }>
  >;
  buildEvent(d: ConformanceEventData): ConformanceOutcome<E>;
  buildSnapshot(d: ConformanceSnapshotData): ConformanceOutcome<S>;
}
