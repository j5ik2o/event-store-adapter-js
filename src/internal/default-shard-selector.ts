import { createShardId, type ShardId } from "../shard-id";
import type { AggregateId, ShardSelector } from "../types";

class DefaultShardSelector<AID extends AggregateId>
  implements ShardSelector<AID>
{
  selectShardId(aggregateId: AID, shardCount: number): ShardId {
    if (aggregateId === undefined || aggregateId === null) {
      throw new Error(`aggregateId is undefined or null: ${aggregateId}`);
    }
    if (!Number.isSafeInteger(shardCount) || shardCount <= 0) {
      throw new Error(
        `shardCount must be a positive safe integer, got ${shardCount}`,
      );
    }
    const hash = this.hashString(aggregateId.asString());
    return createShardId(hash % shardCount);
  }

  private hashString(str: string): number {
    // AggregateId.asString() is user code, so validate runtime values despite the TypeScript type.
    if (typeof str !== "string") {
      throw new Error(`str is not a string: ${str}`);
    }
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & 0xffffffff;
    }
    return hash >>> 0;
  }
}

export { DefaultShardSelector };
