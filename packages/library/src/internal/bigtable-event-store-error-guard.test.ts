import { EventStoreError } from "../event-store-error";
import { isEventStoreError } from "./bigtable-event-store-error-guard";

test("recognizes every EventStoreError the library builds", () => {
  for (const error of [
    EventStoreError.storage("x"),
    EventStoreError.configuration("f", "x"),
    EventStoreError.serialization("serialize", "x"),
    EventStoreError.contractViolation({ rule: "BT-16" }),
    EventStoreError.optimisticLockConflict({ aggregateId: "a", seqNr: 1 }),
  ])
    expect(isEventStoreError(error)).toBe(true);
});

test.each([
  ["null", null],
  ["a string", "storage-error"],
  ["an Error", new Error("x")],
  ["an object with an unknown type", { type: "other", message: "x" }],
  ["an object without a message", { type: "storage-error" }],
])("does not take %s for an EventStoreError", (_name, value) => {
  expect(isEventStoreError(value)).toBe(false);
});
