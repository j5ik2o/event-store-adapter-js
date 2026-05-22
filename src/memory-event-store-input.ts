import type { Aggregate, AggregateId, Event } from "./types";

interface MemoryEventStoreInput<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> {
  events?: Map<AID, E[]>;
  snapshots?: Map<AID, A>;
}

export type { MemoryEventStoreInput };
