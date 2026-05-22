declare const shardCountBrand: unique symbol;

type ShardCount = number & {
  readonly [shardCountBrand]: "ShardCount";
};

function createShardCount(value: number): ShardCount {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`shardCount must be a positive safe integer, got ${value}`);
  }
  return value as ShardCount;
}

export type { ShardCount };
export { createShardCount };
