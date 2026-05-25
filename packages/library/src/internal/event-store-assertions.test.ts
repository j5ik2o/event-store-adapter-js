import { EventStoreError } from "../types";
import {
  assertExpectedVersion,
  assertPersistableUpdateEvent,
  toExpectedVersionError,
} from "./event-store-assertions";
import { UserAccount } from "./test/user-account";
import { UserAccountId } from "./test/user-account-id";

test("rejects created events as update events", () => {
  const [, created] = UserAccount.create(UserAccountId.create("1"), "Alice");

  expect(() => assertPersistableUpdateEvent(created)).toThrow(
    "Cannot persist created event",
  );
});

test("rejects unexpected versions", () => {
  expect(() => assertExpectedVersion(1, 1)).not.toThrow();
  expect(() => assertExpectedVersion(1, 2)).toThrow(
    "Optimistic locking failed: expected version 2, got 1",
  );
});

test("converts unexpected versions to optimistic lock errors", () => {
  expect(toExpectedVersionError(1, 1)).toBeUndefined();
  expect(toExpectedVersionError(1, 2)).toEqual(
    EventStoreError.optimisticLockConflict(
      "Optimistic locking failed: expected version 2, got 1",
    ),
  );
});
