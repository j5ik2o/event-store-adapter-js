import type { AggregateId } from "./aggregate-id";

interface KeyResolver<AID extends AggregateId> {
  resolvePartitionKey(aggregateId: AID, shardCount: number): string;

  resolveSortKey(aggregateId: AID, sequenceNumber: number): string;
}

export type { KeyResolver };
