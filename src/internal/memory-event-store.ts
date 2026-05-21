import type { EventStore } from "../event-store";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import {
  type Aggregate,
  type AggregateId,
  type Event,
  OptimisticLockError,
} from "../types";
import {
  assertEventMatchesAggregate,
  assertExpectedVersion,
  assertPersistableUpdateEvent,
} from "./event-store-assertions";

class MemoryEventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> implements EventStore<AID, A, E>
{
  private readonly events: Map<string, E[]>;
  private readonly snapshots: Map<string, A>;

  constructor(input: MemoryEventStoreInput<AID, A, E> = {}) {
    const events = input.events ?? new Map<AID, E[]>();
    const snapshots = input.snapshots ?? new Map<AID, A>();
    this.events = new Map(
      Array.from(events).map(([key, values]) => {
        return [key.asString(), [...values]];
      }),
    );
    this.snapshots = new Map(
      Array.from(snapshots).map(([key, value]) => {
        return [key.asString(), value];
      }),
    );
  }

  async persistEvent(event: E, version: number): Promise<void> {
    assertPersistableUpdateEvent(event);
    const aggregateIdString = event.aggregateId.asString();
    const snapshot = this.snapshots.get(aggregateIdString);
    if (snapshot === undefined) {
      throw new OptimisticLockError("Optimistic locking failed");
    }
    assertExpectedVersion(snapshot.version, version);
    const events = this.events.get(aggregateIdString) ?? [];
    this.events.set(aggregateIdString, [...events, event]);
    const newVersion = snapshot.version + 1;
    const newSnapshot = snapshot.withVersion(newVersion);
    this.snapshots.set(aggregateIdString, newSnapshot);
  }

  async persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    assertEventMatchesAggregate(event, aggregate);
    const aggregateIdString = event.aggregateId.asString();
    const events = this.events.get(aggregateIdString) ?? [];
    const snapshot = this.snapshots.get(aggregateIdString);

    let newVersion = 1;
    if (event.isCreated) {
      if (snapshot !== undefined || events.length > 0) {
        throw new OptimisticLockError("Optimistic locking failed");
      }
    } else {
      if (snapshot === undefined) {
        throw new OptimisticLockError("Optimistic locking failed");
      }
      assertExpectedVersion(snapshot.version, aggregate.version);
      newVersion = snapshot.version + 1;
    }
    this.events.set(aggregateIdString, [...events, event]);
    const newSnapshot = aggregate.withVersion(newVersion);
    this.snapshots.set(aggregateIdString, newSnapshot);
  }

  async getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]> {
    const aggregateIdString = id.asString();
    const events = this.events.get(aggregateIdString) ?? [];
    return events.filter((event) => event.sequenceNumber >= sequenceNumber);
  }

  async getLatestSnapshotById(id: AID): Promise<A | undefined> {
    const aggregateIdString = id.asString();
    return this.snapshots.get(aggregateIdString);
  }
}

export { MemoryEventStore };
