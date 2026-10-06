import type { ConformanceHooks } from "./conformance-hooks";
import type { ConformanceStore } from "./conformance-store";

export type ConformanceCreatedStore<E, S> = {
  store: ConformanceStore<E, S>;
  hooks: ConformanceHooks;
  dispose(): Promise<void>;
};
