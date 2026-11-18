import { sharedWeakMap } from "./shared-weak-map";

test("shares one weak map for the same registry name", () => {
  const name = "event-store-adapter-js.test.shared-weak-map";
  const first = sharedWeakMap<object, string>(name);
  const second = sharedWeakMap<object, string>(name);
  const key = {};
  first.set(key, "shared");
  expect(second.get(key)).toBe("shared");
});

test("keeps different registry names isolated", () => {
  const first = sharedWeakMap<object, string>(
    "event-store-adapter-js.test.shared-weak-map.first",
  );
  const second = sharedWeakMap<object, string>(
    "event-store-adapter-js.test.shared-weak-map.second",
  );
  expect(first).not.toBe(second);
});
