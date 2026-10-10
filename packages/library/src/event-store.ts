import type { AggregateId } from "./aggregate-id";
import type { DynamoDBEventStoreInput } from "./dynamodb-event-store-input";
import type { EventEnvelope } from "./event-envelope";
import type { EventStoreError } from "./event-store-error";
import { initializeDynamoDBEventStoreInternal } from "./internal/dynamodb-event-store";
import { createMemoryEventStoreInternal } from "./internal/memory-event-store";
import type { LatestSnapshot } from "./latest-snapshot";
import type { MemoryEventStoreInput } from "./memory-event-store-input";
import { Result } from "./result";
import type { SnapshotEnvelope } from "./snapshot-envelope";

export type EventStore<PE = unknown, PS = unknown> = {
  persistEvent(
    event: EventEnvelope<PE>,
  ): Promise<Result<void, EventStoreError>>;

  persistEventAndSnapshot(
    event: EventEnvelope<PE>,
    snapshot: SnapshotEnvelope<PS>,
  ): Promise<Result<void, EventStoreError>>;

  getLatestSnapshotById(
    aggregateId: AggregateId,
  ): Promise<Result<LatestSnapshot<PS> | undefined, EventStoreError>>;

  getEventsByIdSinceSeqNr(
    aggregateId: AggregateId,
    seqNr: number,
  ): Promise<Result<EventEnvelope<PE>[], EventStoreError>>;
};

export namespace EventStore {
  export function createMemory<PE = unknown, PS = unknown>(
    input?: MemoryEventStoreInput<PE, PS>,
  ): Result<EventStore<PE, PS>, EventStoreError> {
    return createMemoryEventStoreInternal(input);
  }

  export async function createDynamoDB<PE = unknown, PS = unknown>(
    input: DynamoDBEventStoreInput<PE, PS>,
  ): Promise<Result<EventStore<PE, PS>, EventStoreError>> {
    const opened = await initializeDynamoDBEventStoreInternal(input);
    if (opened.type === "err") return opened;
    const {
      persistEvent,
      persistEventAndSnapshot,
      getLatestSnapshotById,
      getEventsByIdSinceSeqNr,
    } = opened.value;
    return Result.ok(
      Object.freeze({
        persistEvent,
        persistEventAndSnapshot,
        getLatestSnapshotById,
        getEventsByIdSinceSeqNr,
      }),
    );
  }
}

Object.freeze(EventStore);
