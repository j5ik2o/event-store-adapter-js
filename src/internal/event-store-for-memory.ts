import { Aggregate, AggregateId, Event } from "../types";
import { EventStore } from "../event-store";

class EventStoreForMemory<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> implements EventStore<AID, A, E>
{
  private readonly events: Map<string, E[]>;
  private readonly snapshots: Map<string, A>;

  constructor(
    events: Map<AID, E[]> = new Map(),
    snapshots: Map<AID, A> = new Map(),
  ) {
    this.events = new Map(
      Array.from(events).map(([key, values]) => {
        return [key.asString, values];
      }),
    );
    this.snapshots = new Map(
      Array.from(snapshots).map(([key, value]) => {
        return [key.asString, value];
      }),
    );
  }

  async persistEvent(event: E, version: number): Promise<void> {
    if (event.isCreated) {
      throw new Error("event is created");
    }
    const aggregateIdString = event.aggregateId.asString;
    const snapshot = this.snapshots.get(aggregateIdString);
    if (snapshot === undefined) {
      throw new Error("snapshot is undefined");
    }
    if (snapshot.id.asString !== event.aggregateId.asString) {
      throw new Error(
        "aggregateId mismatch: snapshot.id = " +
          snapshot.id.asString +
          ", event.aggregateId = " +
          event.aggregateId.asString,
      );
    }
    if (snapshot.version !== version) {
      throw new Error("version mismatch");
    }
    const events = this.events.get(aggregateIdString);
    if (events === undefined) {
      throw new Error("events is undefined");
    }
    events.push(event);
    this.events.set(aggregateIdString, events);
    const newVersion = snapshot.version + 1;
    const newSnapshot = snapshot.withVersion(newVersion);
    this.snapshots.set(aggregateIdString, newSnapshot);
  }

  async persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    if (event.aggregateId.asString !== aggregate.id.asString) {
      throw new Error(
        `aggregateId mismatch: expected ${event.aggregateId.asString}, got ${aggregate.id.asString}`,
      );
    }
    const aggregateIdString = event.aggregateId.asString;
    const events = this.events.get(aggregateIdString) ?? [];
    const snapshot = this.snapshots.get(aggregateIdString) ?? aggregate;

    let newVersion = 1;
    if (!event.isCreated) {
      const version = snapshot.version;
      if (version !== aggregate.version) {
        throw new Error("version mismatch");
      }
      newVersion = snapshot.version + 1;
    }
    events.push(event);
    this.events.set(aggregateIdString, events);
    const newSnapshot = snapshot.withVersion(newVersion);
    this.snapshots.set(aggregateIdString, newSnapshot);
  }

  async getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]> {
    const aggregateIdString = id.asString;
    const events = this.events.get(aggregateIdString);
    if (events === undefined) {
      throw new Error("events is undefined");
    }
    return events.filter((event) => event.sequenceNumber >= sequenceNumber);
  }

  async getLatestSnapshotById(id: AID): Promise<A | undefined> {
    const aggregateIdString = id.asString;
    return this.snapshots.get(aggregateIdString);
  }
}

export { EventStoreForMemory };
