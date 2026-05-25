import type { AggregateId } from "./aggregate-id";

type Event<AID extends AggregateId> = {
  typeName: string;
  id: string;
  aggregateId: AID;
  sequenceNumber: number;
  occurredAt: Date;
  isCreated: boolean;
};

export type { Event };
