interface AggregateId {
  typeName: string;
  value: string;
  asString: string;
}

interface Aggregate<
  This extends Aggregate<This, AID>,
  AID extends AggregateId,
> {
  typeName: string;
  id: AID;
  sequenceNumber: number;
  version: number;
  withVersion(version: number): This;
  updateVersion(version: (value: number) => number): This;
}

interface Event<AID extends AggregateId> {
  typeName: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deserialize(bytes: Uint8Array, converter: (json: any) => E): E;
}

interface SnapshotSerializer<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
> {
  serialize(aggregate: A): Uint8Array;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deserialize(bytes: Uint8Array, converter: (json: any) => A): A;
}

export interface Logger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trace?: (...content: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...content: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info: (...content: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...content: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...content: any[]) => void;
}

export {
  AggregateId,
  Aggregate,
  Event,
  KeyResolver,
  EventSerializer,
  SnapshotSerializer,
};
