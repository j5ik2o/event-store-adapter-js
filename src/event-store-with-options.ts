import type { EventStore } from "./event-store";
import type { EventStoreOptions } from "./event-store-options";
import type { Aggregate, AggregateId, Event } from "./types";

interface EventStoreWithOptions<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> extends EventStore<AID, A, E>,
    EventStoreOptions<EventStoreWithOptions<AID, A, E>, AID, A, E> {}

export type { EventStoreWithOptions };
