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

class SnapshotCopyContractError extends Error {
  constructor(aggregateId: string) {
    super(
      `Aggregate.withVersion must return a new instance for aggregate ${aggregateId}`,
    );
    this.name = "SnapshotCopyContractError";
  }
}

class InvalidSeededSnapshotError extends Error {
  constructor(aggregateId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid seeded snapshot for aggregate ${aggregateId}: ${message}`);
    this.name = "InvalidSeededSnapshotError";
    this.cause = cause;
  }
}

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
        return [key.asString(), this.copySeededSnapshot(key, value)];
      }),
    );
  }

  async persistEvent(event: E, expectedVersion: number): Promise<void> {
    assertPersistableUpdateEvent(event);
    const aggregateIdString = event.aggregateId.asString();
    const snapshot = this.snapshots.get(aggregateIdString);
    if (snapshot === undefined) {
      throw new OptimisticLockError(
        `Aggregate does not exist: ${aggregateIdString}`,
      );
    }
    assertEventMatchesAggregate(event, snapshot);
    assertExpectedVersion(snapshot.version, expectedVersion);
    const newVersion = snapshot.version + 1;
    const newSnapshot = snapshot.withVersion(newVersion);
    const storedSnapshot = this.copySnapshot(newSnapshot);
    this.appendEvent(aggregateIdString, event);
    this.snapshots.set(aggregateIdString, storedSnapshot);
  }

  async persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    assertEventMatchesAggregate(event, aggregate);
    const aggregateIdString = event.aggregateId.asString();
    const events = this.events.get(aggregateIdString) ?? [];
    const snapshot = this.snapshots.get(aggregateIdString);

    let newVersion = 1;
    if (event.isCreated) {
      if (snapshot !== undefined || events.length > 0) {
        throw new OptimisticLockError("Aggregate already exists");
      }
    } else {
      if (snapshot === undefined) {
        throw new OptimisticLockError(
          `Aggregate does not exist: ${aggregateIdString}`,
        );
      }
      assertExpectedVersion(snapshot.version, aggregate.version);
      newVersion = snapshot.version + 1;
    }
    const newSnapshot = aggregate.withVersion(newVersion);
    const storedSnapshot = this.copySnapshot(newSnapshot);
    this.appendEvent(aggregateIdString, event);
    this.snapshots.set(aggregateIdString, storedSnapshot);
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
    const snapshot = this.snapshots.get(aggregateIdString);
    return snapshot === undefined ? undefined : this.copySnapshot(snapshot);
  }

  private appendEvent(aggregateIdString: string, event: E): void {
    const events = this.events.get(aggregateIdString) ?? [];
    // Keep histories immutable so callers that seeded the store cannot observe internal array mutation.
    this.events.set(aggregateIdString, [...events, event]);
  }

  private copySnapshot(snapshot: A): A {
    // Aggregate.withVersion must be pure and return a fresh instance; the memory store verifies that contract after the call.
    const copiedSnapshot = snapshot.withVersion(snapshot.version);
    if (copiedSnapshot === snapshot) {
      throw new SnapshotCopyContractError(snapshot.id.asString());
    }
    return copiedSnapshot;
  }

  private copySeededSnapshot(key: AID, snapshot: A): A {
    try {
      return this.copySnapshot(snapshot);
    } catch (error) {
      throw new InvalidSeededSnapshotError(key.asString(), error);
    }
  }
}

export { MemoryEventStore };
