import type { AggregateId } from "./aggregate-id";

interface Event<AID extends AggregateId> {
  typeName: string;
  id: string;
  aggregateId: AID;
  sequenceNumber: number;
  occurredAt: Date;
  isCreated: boolean;
}

export type { Event };
