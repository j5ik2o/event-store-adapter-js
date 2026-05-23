import { createShardCount, EventStore, OptimisticLockError } from ".";

test("exports public API", () => {
  const cause = new Error("conditional check failed");
  const error = new OptimisticLockError("Optimistic locking failed", cause);

  expect(EventStore).toBeDefined();
  expect(createShardCount(32)).toBe(32);
  expect(error.name).toEqual("OptimisticLockError");
  expect(error.cause).toBe(cause);
});
