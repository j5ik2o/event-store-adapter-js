import { Aggregate, AggregateId, Event } from "./types";
import { EventStoreOptions } from "./event-store-options";

interface EventStore<
  AID extends AggregateId,
  A extends Aggregate<AID>,
  E extends Event<AID>,
> extends EventStoreOptions<EventStore<AID, A, E>, AID, A, E> {
  persistEvent(event: E, version: number): Promise<undefined>;
  persistEventAndSnapshot(event: E, aggregate: A): Promise<undefined>;
  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]>;
  getLatestSnapshotById(id: AID): Promise<A | undefined>;
}

export { EventStore };
