import { EventStore, EventStoreError, Result, ShardCount } from ".";

test("exports public API", () => {
  const cause = new Error("conditional check failed");
  const error = EventStoreError.optimisticLockConflict(
    "Optimistic locking failed",
    cause,
  );

  expect(EventStore).toBeDefined();
  expect(ShardCount.create(32)).toBe(32);
  expect(Result.ok("value")).toEqual({ type: "ok", value: "value" });
  expect(Result.err(error)).toEqual({ type: "err", error });
  expect(error.type).toEqual("optimistic-lock-conflict");
  expect(error.cause).toBe(cause);
});

test("creates structured event store errors", () => {
  const cause = new Error("invalid input");

  expect(EventStoreError.configuration("shardCount", "invalid", cause)).toEqual(
    {
      type: "configuration-error",
      fieldName: "shardCount",
      message: "invalid",
      cause,
    },
  );
  expect(EventStoreError.serialization("serialize", "failed", cause)).toEqual({
    type: "serialization-error",
    operation: "serialize",
    message: "failed",
    cause,
  });
  expect(EventStoreError.storage("unavailable", cause)).toEqual({
    type: "storage-error",
    message: "unavailable",
    cause,
  });
  expect(EventStoreError.optimisticLockConflict()).toEqual({
    type: "optimistic-lock-conflict",
    message: "Optimistic locking failed",
    cause: undefined,
  });
});
