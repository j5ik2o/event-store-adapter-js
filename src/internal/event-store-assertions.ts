import {
  type Aggregate,
  type AggregateId,
  type Event,
  OptimisticLockError,
} from "../types";

function assertEventMatchesAggregate<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
>(event: E, aggregate: A): void {
  if (event.aggregateId.asString() !== aggregate.id.asString()) {
    throw new Error(
      `aggregateId mismatch: expected ${event.aggregateId.asString()}, got ${aggregate.id.asString()}`,
    );
  }
}

function assertPersistableUpdateEvent<AID extends AggregateId>(
  event: Event<AID>,
): void {
  if (event.isCreated) {
    throw new Error("Cannot persist created event");
  }
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new OptimisticLockError(
      `Optimistic locking failed: expected version ${expected}, got ${actual}`,
    );
  }
}

export {
  assertEventMatchesAggregate,
  assertExpectedVersion,
  assertPersistableUpdateEvent,
};
