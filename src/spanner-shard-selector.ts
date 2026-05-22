import type { ShardId } from "./shard-id";
import type { AggregateId } from "./types";

interface SpannerShardSelector<AID extends AggregateId> {
  selectShardId(aggregateId: AID, shardCount: number): ShardId;
}

export type { SpannerShardSelector };
