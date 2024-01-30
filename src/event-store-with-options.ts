import { Aggregate, AggregateId, Event } from "./types";
import { EventStoreOptions } from "./event-store-options";
import { EventStore } from "./event-store";

interface EventStoreWithOptions<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> extends EventStore<AID, A, E>,
    EventStoreOptions<EventStoreWithOptions<AID, A, E>, AID, A, E> {}

export { EventStoreWithOptions };
