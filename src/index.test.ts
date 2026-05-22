import { EventStoreFactory, OptimisticLockError } from ".";

test("exports public API", () => {
  const cause = new Error("conditional check failed");
  const error = new OptimisticLockError("Optimistic locking failed", cause);

  expect(EventStoreFactory).toBeDefined();
  expect(error.name).toEqual("OptimisticLockError");
  expect(error.cause).toBe(cause);
  expect(error.stack).toContain("Caused by:");
});
