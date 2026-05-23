import type { DynamoDBEventStoreInput } from "./dynamodb-event-store-input";
import { DynamoDBEventStore } from "./internal/dynamodb-event-store";
import { MemoryEventStore } from "./internal/memory-event-store";
import { SpannerEventStore } from "./internal/spanner-event-store";
import type { MemoryEventStoreInput } from "./memory-event-store-input";
import type { SpannerEventStoreInput } from "./spanner-event-store-input";
import type { Aggregate, AggregateId, Event } from "./types";

export interface EventStore<
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

type EventStoreConstructors = Readonly<{
  ofDynamoDB<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: DynamoDBEventStoreInput<AID, A, E>): EventStore<AID, A, E>;

  ofMemory<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input?: MemoryEventStoreInput<AID, A, E>): EventStore<AID, A, E>;

  ofSpanner<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: SpannerEventStoreInput<AID, A, E>): EventStore<AID, A, E>;
}>;

export const EventStore: EventStoreConstructors = Object.freeze({
  ofDynamoDB<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: DynamoDBEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
    return new DynamoDBEventStore<AID, A, E>(input);
  },

  ofMemory<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input?: MemoryEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
    return new MemoryEventStore(input ?? {});
  },

  ofSpanner<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: SpannerEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
    return new SpannerEventStore<AID, A, E>(input);
  },
});
