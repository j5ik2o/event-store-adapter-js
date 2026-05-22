import type { ShardCount } from "../shard-count";
import type { ShardId } from "../shard-id";
import type { ShardSelector } from "../shard-selector";
import type { AggregateId } from "../types";

class SpannerAggregateKey<AID extends AggregateId> {
  private constructor(
    readonly shardId: ShardId,
    readonly aggregateId: AID,
  ) {}

  static create<AID extends AggregateId>(
    aggregateId: AID,
    shardSelector: ShardSelector<AID>,
    shardCount: ShardCount,
  ): SpannerAggregateKey<AID> {
    return new SpannerAggregateKey(
      shardSelector.selectShardId(aggregateId, shardCount),
      aggregateId,
    );
  }

  get shardIdValue(): number {
    return this.shardId;
  }

  get aggregateIdValue(): string {
    return this.aggregateId.asString();
  }
}

export { SpannerAggregateKey };
