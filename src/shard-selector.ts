import type { AggregateId } from "./aggregate-id";
import type { ShardId } from "./shard-id";

interface ShardSelector<AID extends AggregateId> {
  selectShardId(aggregateId: AID, shardCount: number): ShardId;
}

export type { ShardSelector };
