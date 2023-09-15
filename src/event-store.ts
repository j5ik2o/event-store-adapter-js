import { Aggregate, AggregateId, Event } from "./types";
import { EventStoreOptions } from "./event-store-options";

interface EventStore<
  AID extends AggregateId,
  A extends Aggregate<AID>,
  E extends Event<AID>,
> extends EventStoreOptions<EventStore<AID, A, E>, AID, A, E> {
  persistEvent(event: E): void;
  persistEventAndSnapshot(event: E, aggregate: A): void;
  getEventsByIdSinceSequenceNumber(id: AID, sequenceNumber: number): E[];
  getLatestSnapshotById(id: AID): A | undefined;
}
