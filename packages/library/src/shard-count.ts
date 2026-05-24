declare const shardCountBrand: unique symbol;

export type ShardCount = number & {
  readonly [shardCountBrand]: "ShardCount";
};

export namespace ShardCount {
  export function create(value: number): ShardCount {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `shardCount must be a positive safe integer, got ${value}`,
      );
    }
    return value as ShardCount;
  }
}

Object.freeze(ShardCount);
