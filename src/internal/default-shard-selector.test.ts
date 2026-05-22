import { createShardId } from "../shard-id";
import { DefaultShardSelector } from "./default-shard-selector";
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
    const selector = new DefaultShardSelector<UserAccountId>();

    expect(selector.selectShardId(new UserAccountId(value), 32)).toBe(
      createShardId(shardId),
    );
  });

  test("matches the legacy DynamoDB shard hash coercion", () => {
    const shardCount = 32;
    const selector = new DefaultShardSelector<UserAccountId>();
    const ids = [
      new UserAccountId("01HZX3D9Z2C4J9V3K9WQ6T8Y7A"),
      new UserAccountId("user-account-with-a-long-stable-id-000000000001"),
      new UserAccountId("x".repeat(1000)),
    ];

    for (const id of ids) {
      expect(selector.selectShardId(id, shardCount)).toBe(
        createShardId(selectLegacyDynamoDBShardId(id, shardCount)),
      );
    }
  });

  test("rejects invalid inputs before selecting a shard", () => {
    const selector = new DefaultShardSelector<UserAccountId>();
    const id = new UserAccountId("user-1");
    const invalidId = {
      typeName: "user-account",
      value: id.value,
      asString: () => undefined,
    } as unknown as UserAccountId;

    expect(() =>
      selector.selectShardId(undefined as unknown as UserAccountId, 32),
    ).toThrow("aggregateId is undefined or null");
    expect(() => selector.selectShardId(id, 0)).toThrow(
      "shardCount must be a positive safe integer",
    );
    expect(() => selector.selectShardId(invalidId, 32)).toThrow(
      "str is not a string",
    );
  });
});
