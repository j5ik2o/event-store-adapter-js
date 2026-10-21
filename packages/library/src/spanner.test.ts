import * as entry from "./spanner";

test("the Spanner entry exposes the frozen SpannerEventStore namespace and the v4 migration function", () => {
  expect(Object.keys(entry).sort()).toEqual([
    "SpannerEventStore",
    "migrateV4Spanner",
  ]);
  expect(typeof entry.migrateV4Spanner).toBe("function");
  expect(Object.isFrozen(entry.SpannerEventStore)).toBe(true);
  expect(typeof entry.SpannerEventStore.create).toBe("function");
});
