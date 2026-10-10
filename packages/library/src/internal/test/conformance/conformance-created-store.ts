import type { ConformanceHooks } from "./conformance-hooks";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceStore } from "./conformance-store";

export type ConformanceCreatedStore<E, S> = {
  outcome: ConformanceOutcome<ConformanceStore<E, S>>;
  hooks: ConformanceHooks;
  dispose(): Promise<void>;
};
