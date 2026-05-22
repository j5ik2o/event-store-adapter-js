import type { Aggregate } from "./aggregate";
import type { AggregateId } from "./aggregate-id";

interface SnapshotSerializer<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
> {
  serialize(aggregate: A): Uint8Array;
  deserialize(bytes: Uint8Array, converter: (json: unknown) => A): A;
}

export type { SnapshotSerializer };
