import { DefaultKeyResolver } from "./default-key-resolver";
import { UserAccountId } from "./test/user-account-id";

describe("DefaultKeyResolver", () => {
  test("resolves partition and sort keys", () => {
    const aggregateId = new UserAccountId("user-1");
    const resolver = new DefaultKeyResolver<UserAccountId>();

    expect(resolver.resolvePartitionKey(aggregateId, 32)).toMatch(
      /^user-account-\d+$/,
    );
    expect(resolver.resolveSortKey(aggregateId, 2)).toEqual(
      "user-account-user-1-2",
    );
  });

  test("rejects missing aggregate id", () => {
    const resolver = new DefaultKeyResolver<UserAccountId>();

    expect(() => resolver.resolvePartitionKey(undefined as never, 32)).toThrow(
      "aggregateId is undefined or null",
    );
  });
});
