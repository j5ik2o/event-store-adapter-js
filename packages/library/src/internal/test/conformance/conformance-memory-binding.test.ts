import * as factory from "../../memory-event-store";
import { ConformanceMemoryBinding } from "./conformance-memory-binding";

test("internal hook injection stays behind the public factory and preserves the original cause", async () => {
  const original = factory.createMemoryEventStoreInternal;
  const binding = new ConformanceMemoryBinding();
  const created = await binding.createStore({
    config: { retentionCount: null, retentionMode: "delete" },
    seedItems: [],
    faults: [
      {
        operation: 1,
        phase: "commit",
        kind: "storage-error",
        injection: "replace-request",
        repeat: { mode: "count", count: 1 },
        details: { message: "commit unavailable" },
      },
    ],
  });
  expect(factory.createMemoryEventStoreInternal).toBe(original);
  if (created.outcome.kind !== "ok") throw new Error("creation failed");
  created.hooks.beginOperation?.(1);
  const event = binding.buildEvent({
    aggregateId: { typeName: "Order", value: "1" },
    seqNr: BigInt(1),
    occurredAtEpochNanos: BigInt(0),
    payload: {},
  });
  if (event.kind !== "ok") throw new Error("event failed");
  const result = await created.outcome.value.persistEvent(event.value);
  expect(result).toMatchObject({
    kind: "error",
    category: "storage",
    cause: new Error("commit unavailable"),
  });
  created.hooks.finishOperation?.(1);
  expect(created.hooks.evidence?.()).toMatchObject({
    faults: [{ fired: 1, applied: 1 }],
  });
  expect(
    await created.outcome.value.getEventsByIdSinceSeqNr(
      { typeName: "Order", value: "1" },
      BigInt(1),
    ),
  ).toEqual({ kind: "ok", value: [] });
  await created.dispose();
});
