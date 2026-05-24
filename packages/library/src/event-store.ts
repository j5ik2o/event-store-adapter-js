import type { DynamoDBEventStoreInput } from "./dynamodb-event-store-input";
import { createDynamoDBEventStore } from "./internal/dynamodb-event-store";
import { createMemoryEventStore } from "./internal/memory-event-store";
import { createSpannerEventStore } from "./internal/spanner-event-store";
import type { MemoryEventStoreInput } from "./memory-event-store-input";
import type { SpannerEventStoreInput } from "./spanner-event-store-input";
import type {
  Aggregate,
  AggregateId,
  Event,
  EventStoreError,
  Result,
} from "./types";

export type EventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> = {
  persistEvent(
    event: E,
    expectedVersion: number,
  ): Promise<Result<void, EventStoreError>>;
  persistEventAndSnapshot(
    event: E,
    aggregate: A,
  ): Promise<Result<void, EventStoreError>>;
  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]>;
  getLatestSnapshotById(id: AID): Promise<A | undefined>;
};

export namespace EventStore {
  export function createDynamoDB<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: DynamoDBEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
    return createDynamoDBEventStore<AID, A, E>(input);
  }

  export function createMemory<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input?: MemoryEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
    return createMemoryEventStore(input ?? {});
  }

  export function createSpanner<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(input: SpannerEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
    return createSpannerEventStore<AID, A, E>(input);
  }
}

Object.freeze(EventStore);
