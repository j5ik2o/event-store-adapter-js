import * as entry from "./bigtable";

test("the Bigtable entry exposes only the frozen BigtableEventStore namespace", () => {
  expect(Object.keys(entry)).toEqual(["BigtableEventStore"]);
  expect(Object.isFrozen(entry.BigtableEventStore)).toBe(true);
  expect(Object.keys(entry.BigtableEventStore).sort()).toEqual([
    "create",
    "initialize",
  ]);
  expect(typeof entry.BigtableEventStore.initialize).toBe("function");
  expect(typeof entry.BigtableEventStore.create).toBe("function");
});

test("the original, Spanner and SQLite entries do not expose BigtableEventStore", () => {
  for (const other of [
    require("./index"),
    require("./spanner"),
    require("./sqlite"),
  ]) {
    expect("BigtableEventStore" in other).toBe(false);
  }
});
