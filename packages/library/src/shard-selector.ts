import type { AggregateId } from "./aggregate-id";
import type { ShardCount } from "./shard-count";
import type { ShardId } from "./shard-id";

interface ShardSelector<AID extends AggregateId> {
  selectShardId(aggregateId: AID, shardCount: ShardCount): ShardId;
}

export type { ShardSelector };
