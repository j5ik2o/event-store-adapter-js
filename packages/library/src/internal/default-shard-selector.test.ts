import { ShardCount } from "../shard-count";
import { ShardId } from "../shard-id";
import { createDefaultShardSelector } from "./default-shard-selector";
import { UserAccountId } from "./test/user-account-id";

describe("DefaultShardSelector", () => {
  function selectLegacyDynamoDBShardId(
    aggregateId: UserAccountId,
    shardCount: number,
  ): number {
    let hash = 0;
    const str = aggregateId.asString();
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return (hash >>> 0) % shardCount;
  }

  test.each([
    ["01HZX3D9Z2C4J9V3K9WQ6T8Y7A", 11],
    ["user-account-with-a-long-stable-id-000000000001", 31],
  ])("selects a stable shard for %s", (value, shardId) => {
    const selector = createDefaultShardSelector<UserAccountId>();

    expect(
      selector.selectShardId(
        UserAccountId.create(value),
        ShardCount.create(32),
      ),
    ).toBe(ShardId.create(shardId));
  });

  test("matches the legacy DynamoDB shard hash coercion", () => {
    const shardCount = ShardCount.create(32);
    const selector = createDefaultShardSelector<UserAccountId>();
    const ids = [
      UserAccountId.create("01HZX3D9Z2C4J9V3K9WQ6T8Y7A"),
      UserAccountId.create("user-account-with-a-long-stable-id-000000000001"),
      UserAccountId.create("x".repeat(1000)),
    ];

    for (const id of ids) {
      expect(selector.selectShardId(id, shardCount)).toBe(
        ShardId.create(selectLegacyDynamoDBShardId(id, shardCount)),
      );
    }
  });

  test("rejects invalid inputs before selecting a shard", () => {
    const selector = createDefaultShardSelector<UserAccountId>();
    const id = UserAccountId.create("user-1");
    const invalidId = {
      typeName: "user-account",
      value: id.value,
      asString: () => undefined,
    } as unknown as UserAccountId;

    expect(() =>
      selector.selectShardId(
        undefined as unknown as UserAccountId,
        ShardCount.create(32),
      ),
    ).toThrow("aggregateId is undefined or null");
    expect(() =>
      selector.selectShardId(id, 0 as unknown as ShardCount),
    ).toThrow("shardCount must be a positive safe integer");
    expect(() =>
      selector.selectShardId(invalidId, ShardCount.create(32)),
    ).toThrow("str is not a string");
  });
});
