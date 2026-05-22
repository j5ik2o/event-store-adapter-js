import type { ShardId } from "../shard-id";
import type { SpannerShardSelector } from "../spanner-shard-selector";
import type { AggregateId } from "../types";

class SpannerAggregateKey<AID extends AggregateId> {
  private constructor(
    readonly shardId: ShardId,
    readonly aggregateId: AID,
  ) {}

  static create<AID extends AggregateId>(
    aggregateId: AID,
    shardSelector: SpannerShardSelector<AID>,
    shardCount: number,
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
