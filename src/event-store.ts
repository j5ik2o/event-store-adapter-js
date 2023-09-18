import { Aggregate, AggregateId, Event } from "./types";
import { EventStoreOptions } from "./event-store-options";

interface EventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> extends EventStoreOptions<EventStore<AID, A, E>, AID, A, E> {
  persistEvent(event: E, version: number): Promise<void>;
  persistEventAndSnapshot(event: E, aggregate: A): Promise<void>;
  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
    converter: (json: string) => E,
  ): Promise<E[]>;
  getLatestSnapshotById(
    id: AID,
    converter: (json: string) => A,
  ): Promise<A | undefined>;
}

export { EventStore };
