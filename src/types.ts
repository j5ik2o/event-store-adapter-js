interface AggregateId {
  typeName: string;
  value: string;
  asString: string;
}

interface Aggregate<This extends Aggregate<This, AID>,AID extends AggregateId> {
  id: AID;
  sequenceNumber: number;
  version: number;
  withVersion(version: number): This;
  updateVersion(version: (value: number) => number): This;
}

interface Event<AID extends AggregateId> {
  id: string;
  aggregateId: AID;
  sequenceNumber: number;
  occurredAt: Date;
  isCreated: boolean;
}

interface KeyResolver<AID extends AggregateId> {
  resolvePartitionKey(aggregateId: AID, shardCount: number): string;

  resolveSortKey(aggregateId: AID, sequenceNumber: number): string;
}

interface EventSerializer<AID extends AggregateId, E extends Event<AID>> {
  serialize(event: E): Uint8Array;

  deserialize(bytes: Uint8Array, converter: (json: string) => E): E;
}

interface SnapshotSerializer<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
> {
  serialize(aggregate: A): Uint8Array;

  deserialize(bytes: Uint8Array, converter: (json: string) => A): A;
}

export {
  AggregateId,
  Aggregate,
  Event,
  KeyResolver,
  EventSerializer,
  SnapshotSerializer,
};
