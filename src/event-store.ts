import type { DynamoDBEventStoreInput } from "./dynamodb-event-store-input";
import { DynamoDBEventStore } from "./internal/dynamodb-event-store";
import { MemoryEventStore } from "./internal/memory-event-store";
import type { MemoryEventStoreInput } from "./memory-event-store-input";
import type { Aggregate, AggregateId, Event } from "./types";

interface EventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> {
  persistEvent(event: E, expectedVersion: number): Promise<void>;
  persistEventAndSnapshot(event: E, aggregate: A): Promise<void>;
  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]>;
  getLatestSnapshotById(id: AID): Promise<A | undefined>;
}

class EventStoreFactory {
  static ofDynamoDB<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: DynamoDBEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
    return new DynamoDBEventStore<AID, A, E>(input);
  }

  static ofMemory<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: MemoryEventStoreInput<AID, A, E> = {}): EventStore<AID, A, E> {
    return new MemoryEventStore(input);
  }
}

export { type EventStore, EventStoreFactory };
