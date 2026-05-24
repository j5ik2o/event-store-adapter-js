import type { EventStore } from "../event-store";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import {
  type Aggregate,
  type AggregateId,
  type Event,
  EventStoreError,
  Result,
} from "../types";
import {
  assertEventMatchesAggregate,
  assertPersistableUpdateEvent,
  toExpectedVersionError,
} from "./event-store-assertions";

function createMemoryEventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
>(input: MemoryEventStoreInput<AID, A, E> = {}): EventStore<AID, A, E> {
  const events = new Map(
    Array.from(input.events ?? new Map<AID, E[]>()).map(([key, values]) => {
      return [key.asString(), [...values]];
    }),
  );
  const snapshots = new Map(
    Array.from(input.snapshots ?? new Map<AID, A>()).map(([key, value]) => {
      return [key.asString(), copySeededSnapshot(key, value)];
    }),
  );

  function appendEvent(aggregateIdString: string, event: E): void {
    const aggregateEvents = events.get(aggregateIdString) ?? [];
    events.set(aggregateIdString, [...aggregateEvents, event]);
  }

  function assertSnapshotCopy(snapshot: A, copiedSnapshot: A): void {
    if (copiedSnapshot === snapshot) {
      throw new Error(
        `Aggregate.withVersion must return a new instance for aggregate ${snapshot.id.asString()}`,
      );
    }
  }

  function copySnapshot(snapshot: A): A {
    const copiedSnapshot = snapshot.withVersion(snapshot.version);
    assertSnapshotCopy(snapshot, copiedSnapshot);
    return copiedSnapshot;
  }

  function copySeededSnapshot(key: AID, snapshot: A): A {
    try {
      return copySnapshot(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid seeded snapshot for aggregate ${key.asString()}: ${message}`,
      );
    }
  }

  return Object.freeze({
    async persistEvent(event: E, expectedVersion: number) {
      assertPersistableUpdateEvent(event);
      const aggregateIdString = event.aggregateId.asString();
      const snapshot = snapshots.get(aggregateIdString);
      if (snapshot === undefined) {
        return Result.err(
          EventStoreError.optimisticLockConflict(
            `Aggregate does not exist: ${aggregateIdString}`,
          ),
        );
      }
      assertEventMatchesAggregate(event, snapshot);
      const versionError = toExpectedVersionError(
        snapshot.version,
        expectedVersion,
      );
      if (versionError !== undefined) {
        return Result.err(versionError);
      }
      const newVersion = snapshot.version + 1;
      const newSnapshot = snapshot.withVersion(newVersion);
      assertSnapshotCopy(snapshot, newSnapshot);
      appendEvent(aggregateIdString, event);
      snapshots.set(aggregateIdString, newSnapshot);
      return Result.ok(undefined);
    },

    async persistEventAndSnapshot(event: E, aggregate: A) {
      assertEventMatchesAggregate(event, aggregate);
      const aggregateIdString = event.aggregateId.asString();
      const aggregateEvents = events.get(aggregateIdString) ?? [];
      const snapshot = snapshots.get(aggregateIdString);

      let newVersion = 1;
      if (event.isCreated) {
        if (snapshot !== undefined || aggregateEvents.length > 0) {
          return Result.err(
            EventStoreError.optimisticLockConflict("Aggregate already exists"),
          );
        }
      } else {
        if (snapshot === undefined) {
          return Result.err(
            EventStoreError.optimisticLockConflict(
              `Aggregate does not exist: ${aggregateIdString}`,
            ),
          );
        }
        const versionError = toExpectedVersionError(
          snapshot.version,
          aggregate.version,
        );
        if (versionError !== undefined) {
          return Result.err(versionError);
        }
        newVersion = snapshot.version + 1;
      }
      const newSnapshot = aggregate.withVersion(newVersion);
      assertSnapshotCopy(aggregate, newSnapshot);
      appendEvent(aggregateIdString, event);
      snapshots.set(aggregateIdString, newSnapshot);
      return Result.ok(undefined);
    },

    async getEventsByIdSinceSequenceNumber(
      id: AID,
      sequenceNumber: number,
    ): Promise<E[]> {
      const aggregateIdString = id.asString();
      const aggregateEvents = events.get(aggregateIdString) ?? [];
      return aggregateEvents.filter(
        (event) => event.sequenceNumber >= sequenceNumber,
      );
    },

    async getLatestSnapshotById(id: AID): Promise<A | undefined> {
      const aggregateIdString = id.asString();
      const snapshot = snapshots.get(aggregateIdString);
      return snapshot === undefined ? undefined : copySnapshot(snapshot);
    },
  });
}

export { createMemoryEventStore };
