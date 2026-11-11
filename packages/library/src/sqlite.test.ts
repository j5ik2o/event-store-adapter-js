import * as entry from "./sqlite";

test("the SQLite entry exposes only the frozen SqliteBlockingExecution and SqliteEventStore namespaces", () => {
  expect(Object.keys(entry).sort()).toEqual([
    "SqliteBlockingExecution",
    "SqliteEventStore",
  ]);
  expect(Object.isFrozen(entry.SqliteEventStore)).toBe(true);
  expect(Object.keys(entry.SqliteEventStore).sort()).toEqual([
    "create",
    "createOffloaded",
    "initialize",
  ]);
  expect(typeof entry.SqliteEventStore.initialize).toBe("function");
  expect(typeof entry.SqliteEventStore.create).toBe("function");
  expect(typeof entry.SqliteEventStore.createOffloaded).toBe("function");
  expect(Object.isFrozen(entry.SqliteBlockingExecution)).toBe(true);
  expect(Object.keys(entry.SqliteBlockingExecution)).toEqual(["singleWorker"]);
});
