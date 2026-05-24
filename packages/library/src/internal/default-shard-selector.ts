import { ShardId } from "../shard-id";
import type { AggregateId, ShardCount, ShardSelector } from "../types";

function createDefaultShardSelector<
  AID extends AggregateId,
>(): ShardSelector<AID> {
  return Object.freeze({
    selectShardId(aggregateId: AID, shardCount: ShardCount): ShardId {
      if (aggregateId === undefined || aggregateId === null) {
        throw new Error(`aggregateId is undefined or null: ${aggregateId}`);
      }
      if (!Number.isSafeInteger(shardCount) || shardCount <= 0) {
        throw new Error(
          `shardCount must be a positive safe integer, got ${shardCount}`,
        );
      }
      const hash = hashString(aggregateId.asString());
      return ShardId.create(hash % shardCount);
    },
  });
}

function hashString(str: string): number {
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

export { createDefaultShardSelector };
