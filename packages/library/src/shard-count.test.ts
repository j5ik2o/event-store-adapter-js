import { ShardCount } from "./shard-count";

describe("ShardCount.create", () => {
  test("returns a positive safe integer shard count", () => {
    expect(ShardCount.create(32)).toBe(32);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid shardCount %s", (value) => {
    expect(() => ShardCount.create(value)).toThrow(
      "shardCount must be a positive safe integer",
    );
  });
});
