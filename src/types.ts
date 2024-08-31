interface AggregateId {
  typeName: string;
  value: string;
  asString: () => string;
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
  // biome-ignore lint/suspicious/noExplicitAny:
  deserialize(bytes: Uint8Array, converter: (json: any) => E): E;
}

interface SnapshotSerializer<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
> {
  serialize(aggregate: A): Uint8Array;
  // biome-ignore lint/suspicious/noExplicitAny:
  deserialize(bytes: Uint8Array, converter: (json: any) => A): A;
}

export interface Logger {
  // biome-ignore lint/suspicious/noExplicitAny:
  trace?: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny:
  debug: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny:
  info: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny:
  warn: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny:
  error: (...content: any[]) => void;
}

class OptimisticLockError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "OptimisticLockError";
    this.cause = cause;
    if (cause) {
      this.stack = `${this.stack}\nCaused by:\n${cause.stack}`;
    }
  }
}

export {
  type AggregateId,
  type Aggregate,
  type Event,
  type KeyResolver,
  type EventSerializer,
  type SnapshotSerializer,
  OptimisticLockError,
};
