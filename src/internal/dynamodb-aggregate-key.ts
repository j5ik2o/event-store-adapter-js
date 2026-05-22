import type { ShardId } from "../shard-id";
import type { ShardSelector } from "../shard-selector";
import type { AggregateId } from "../types";

class DynamoDBAggregateKey<AID extends AggregateId> {
  private constructor(
    readonly shardId: ShardId,
    readonly aggregateId: AID,
    readonly sequenceNumber: number,
  ) {}

  static create<AID extends AggregateId>(
    aggregateId: AID,
    sequenceNumber: number,
    shardSelector: ShardSelector<AID>,
    shardCount: number,
  ): DynamoDBAggregateKey<AID> {
    return new DynamoDBAggregateKey(
      shardSelector.selectShardId(aggregateId, shardCount),
      aggregateId,
      sequenceNumber,
    );
  }

  get partitionKeyValue(): string {
    return `${this.aggregateId.typeName}-${this.shardId}`;
  }

  get sortKeyValue(): string {
    return `${this.aggregateId.typeName}-${this.aggregateId.value}-${this.sequenceNumber}`;
  }
}

export { DynamoDBAggregateKey };
