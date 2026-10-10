import { ConformanceFaultRegistry } from "./conformance-fault-registry";

const fault = (
  phase: string,
  operation = 0,
  repeat = { mode: "count", count: 1 },
) => ({
  operation,
  phase,
  kind: "storage-error",
  injection: "replace-request",
  repeat,
  details: { message: phase },
});

test("shares operation zero and preserves declaration order across repeat counts and phases", () => {
  const registry = new ConformanceFaultRegistry([
    fault("commit", 0, { mode: "count", count: 2 }),
    fault("commit"),
    fault("serialize-event"),
  ]);
  const serialization = registry.take("serialize-event");
  expect(serialization?.index).toBe(2);
  registry.applied(serialization?.index as number);
  for (const expected of [0, 0, 1]) {
    const taken = registry.take("commit");
    expect(taken?.index).toBe(expected);
    registry.applied(taken?.index as number);
  }
  expect(registry.take("commit")).toBeUndefined();
  registry.finish(0);
  expect(
    registry.snapshot().map((entry) => [entry.fired, entry.applied]),
  ).toEqual([
    [2, 2],
    [1, 1],
    [1, 1],
  ]);
});

test("does not fire a different operation and rejects unconsumed or unapplied faults", () => {
  const registry = new ConformanceFaultRegistry([fault("commit", 1)]);
  expect(registry.take("commit")).toBeUndefined();
  expect(() => registry.finish(1)).toThrow("unfired");
  registry.begin(1);
  registry.take("commit");
  expect(() => registry.finish(1)).toThrow("not applied");
  registry.applied(0);
  registry.finish(1);
});

test("until-operation-finishes requires a real application and remains active for retries", () => {
  const registry = new ConformanceFaultRegistry([
    {
      ...fault("retention-delete", 1),
      repeat: { mode: "until-operation-finishes" },
    },
  ]);
  registry.begin(1);
  expect(() => registry.finish(1)).toThrow("unfired");
  for (let n = 0; n < 3; n += 1) {
    const taken = registry.take("retention-delete");
    registry.applied(taken?.index as number);
  }
  registry.finish(1);
  registry.begin(2);
  expect(registry.take("retention-delete")).toBeUndefined();
});
