declare const shardIdBrand: unique symbol;

export type ShardId = number & {
  readonly [shardIdBrand]: "ShardId";
};

export namespace ShardId {
  export function create(value: number): ShardId {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `shardId must be a non-negative safe integer, got ${value}`,
      );
    }
    return value as ShardId;
  }
}

Object.freeze(ShardId);
