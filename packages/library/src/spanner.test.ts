import * as entry from "./spanner";

test("the Spanner entry exposes the frozen SpannerEventStore namespace", () => {
  expect(Object.keys(entry)).toEqual(["SpannerEventStore"]);
  expect(Object.isFrozen(entry.SpannerEventStore)).toBe(true);
  expect(typeof entry.SpannerEventStore.create).toBe("function");
});
