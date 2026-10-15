import { mutateConformancePayload } from "./conformance-payload-mutation";

const original = () => ({ items: [{ qty: 1 }], note: "original" });

test("rewrites the existing position named by the JSON Pointer", () => {
  const payload = original();
  mutateConformancePayload(payload, "/items/0/qty", 99);
  expect(payload).toEqual({ items: [{ qty: 99 }], note: "original" });
});

test("resolves escaped keys: ~1 means slash and ~0 means tilde", () => {
  const payload = { "a/b": 1, "m~n": 2 };
  mutateConformancePayload(payload, "/a~1b", 5);
  expect(payload).toEqual({ "a/b": 5, "m~n": 2 });
  const other = { "a/b": 1, "m~n": 2 };
  mutateConformancePayload(other, "/m~0n", 7);
  expect(other).toEqual({ "a/b": 1, "m~n": 7 });
});

test("rejects empty, out-of-range, missing and dash pointers and leaves the payload unchanged", () => {
  for (const pointer of ["", "/items/5/qty", "/missing", "/items/-"]) {
    const payload = original();
    expect(() => mutateConformancePayload(payload, pointer, 99)).toThrow();
    expect(payload).toEqual(original());
  }
});

test("rejects a mutation that does not change the value", () => {
  const payload = original();
  expect(() => mutateConformancePayload(payload, "/items/0/qty", 1)).toThrow(
    "mutation does not change the value",
  );
  expect(payload).toEqual(original());
});
