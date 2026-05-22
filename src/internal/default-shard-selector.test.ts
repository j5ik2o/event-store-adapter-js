import { createShardId } from "../shard-id";
import { DefaultShardSelector } from "./default-shard-selector";
import { UserAccountId } from "./test/user-account-id";

describe("DefaultShardSelector", () => {
  test.each([
    ["01HZX3D9Z2C4J9V3K9WQ6T8Y7A", 11],
    ["user-account-with-a-long-stable-id-000000000001", 31],
  ])("selects a stable shard for %s", (value, shardId) => {
    const selector = new DefaultShardSelector<UserAccountId>();

    expect(selector.selectShardId(new UserAccountId(value), 32)).toBe(
      createShardId(shardId),
    );
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
