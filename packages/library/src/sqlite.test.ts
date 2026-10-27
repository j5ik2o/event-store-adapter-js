import * as entry from "./sqlite";

test("the SQLite entry exposes only the frozen SqliteEventStore namespace", () => {
  expect(Object.keys(entry)).toEqual(["SqliteEventStore"]);
  expect(Object.isFrozen(entry.SqliteEventStore)).toBe(true);
  expect(Object.keys(entry.SqliteEventStore).sort()).toEqual([
    "create",
    "initialize",
  ]);
  expect(typeof entry.SqliteEventStore.initialize).toBe("function");
  expect(typeof entry.SqliteEventStore.create).toBe("function");
});
