import { Aggregate, AggregateId, Event } from "./types";
import { EventStoreOptions } from "./event-store-options";

interface EventStoreAsync<
  AID extends AggregateId,
  A extends Aggregate<AID>,
  E extends Event<AID>,
> extends EventStoreOptions<EventStoreAsync<AID, A, E>, AID, A, E> {
  persistEvent(event: E): Promise<void>;
  persistEventAndSnapshot(event: E, aggregate: A): Promise<void>;
  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]>;
  getLatestSnapshotById(id: AID): Promise<A | undefined>;
}
