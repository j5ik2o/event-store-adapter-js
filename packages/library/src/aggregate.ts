import type { AggregateId } from "./aggregate-id";

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

export type { Aggregate };
