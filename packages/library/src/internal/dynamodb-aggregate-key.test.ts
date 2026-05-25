import { ShardCount } from "../shard-count";
import { ShardId } from "../shard-id";
import type { ShardSelector } from "../shard-selector";
import { createDynamoDBAggregateKey } from "./dynamodb-aggregate-key";
import { UserAccountId } from "./test/user-account-id";

describe("DynamoDBAggregateKey", () => {
  test("formats DynamoDB partition and sort keys from a selected shard", () => {
    const shardSelector: ShardSelector<UserAccountId> = {
      selectShardId: jest.fn(() => ShardId.create(7)),
    };
    const aggregateId = UserAccountId.create("user-1");

    const key = createDynamoDBAggregateKey(
      aggregateId,
      2,
      shardSelector,
      ShardCount.create(32),
    );

    expect(key.partitionKeyValue).toBe("user-account-7");
    expect(key.sortKeyValue).toBe("user-account-user-1-2");
    expect(shardSelector.selectShardId).toHaveBeenCalledWith(aggregateId, 32);
  });

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid sequenceNumber %s", (sequenceNumber) => {
    const shardSelector: ShardSelector<UserAccountId> = {
      selectShardId: jest.fn(() => ShardId.create(7)),
    };
    const aggregateId = UserAccountId.create("user-1");

    expect(() =>
      createDynamoDBAggregateKey(
        aggregateId,
        sequenceNumber,
        shardSelector,
        ShardCount.create(32),
      ),
    ).toThrow("sequenceNumber must be a non-negative safe integer");
    expect(shardSelector.selectShardId).not.toHaveBeenCalled();
  });
});
