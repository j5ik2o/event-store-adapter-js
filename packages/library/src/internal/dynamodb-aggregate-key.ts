import type { ShardCount } from "../shard-count";
import type { ShardId } from "../shard-id";
import type { ShardSelector } from "../shard-selector";
import type { AggregateId } from "../types";

type DynamoDBAggregateKey<AID extends AggregateId> = Readonly<{
  shardId: ShardId;
  aggregateId: AID;
  sequenceNumber: number;
  partitionKeyValue: string;
  sortKeyValue: string;
}>;

function createDynamoDBAggregateKey<AID extends AggregateId>(
  aggregateId: AID,
  sequenceNumber: number,
  shardSelector: ShardSelector<AID>,
  shardCount: ShardCount,
): DynamoDBAggregateKey<AID> {
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) {
    throw new Error(
      `sequenceNumber must be a non-negative safe integer, got ${sequenceNumber}`,
    );
  }
  const shardId = shardSelector.selectShardId(aggregateId, shardCount);
  return Object.freeze({
    shardId,
    aggregateId,
    sequenceNumber,
    partitionKeyValue: `${aggregateId.typeName}-${shardId}`,
    sortKeyValue: `${aggregateId.typeName}-${aggregateId.value}-${sequenceNumber}`,
  });
}

export type { DynamoDBAggregateKey };
export { createDynamoDBAggregateKey };
