import type { ShardCount } from "../shard-count";
import type { ShardId } from "../shard-id";
import type { ShardSelector } from "../shard-selector";
import type { AggregateId } from "../types";

type SpannerAggregateKey<AID extends AggregateId> = Readonly<{
  shardId: ShardId;
  aggregateId: AID;
  shardIdValue: number;
  aggregateIdValue: string;
}>;

function createSpannerAggregateKey<AID extends AggregateId>(
  aggregateId: AID,
  shardSelector: ShardSelector<AID>,
  shardCount: ShardCount,
): SpannerAggregateKey<AID> {
  const shardId = shardSelector.selectShardId(aggregateId, shardCount);
  return Object.freeze({
    shardId,
    aggregateId,
    shardIdValue: shardId,
    aggregateIdValue: aggregateId.asString(),
  });
}

export type { SpannerAggregateKey };
export { createSpannerAggregateKey };
