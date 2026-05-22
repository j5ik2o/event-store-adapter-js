declare const shardIdBrand: unique symbol;

type ShardId = number & {
  readonly [shardIdBrand]: "ShardId";
};

function createShardId(value: number): ShardId {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `shardId must be a non-negative safe integer, got ${value}`,
    );
  }
  return value as ShardId;
}

export type { ShardId };
export { createShardId };
