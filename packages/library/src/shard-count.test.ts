import { createShardCount } from "./shard-count";

describe("createShardCount", () => {
  test("returns a positive safe integer shard count", () => {
    expect(createShardCount(32)).toBe(32);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid shardCount %s", (value) => {
    expect(() => createShardCount(value)).toThrow(
      "shardCount must be a positive safe integer",
    );
  });
});
