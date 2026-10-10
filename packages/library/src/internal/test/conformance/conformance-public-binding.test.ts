import { EventStoreError } from "../../../event-store-error";
import { Result } from "../../../result";
import { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { ConformanceMemoryBinding } from "./conformance-memory-binding";

const binding = new ConformanceMemoryBinding();
test("maps real public construction failures and preserves cause", () => {
  const cause = new Error("original");
  expect(
    binding.outcome(Result.err(EventStoreError.storage("failed", cause))),
  ).toMatchObject({ kind: "error", category: "storage", cause });
  expect(
    binding.buildEvent({
      aggregateId: { typeName: "Order", value: "1" },
      seqNr: BigInt(0),
      occurredAtEpochNanos: BigInt(0),
      payload: {},
    }),
  ).toMatchObject({
    kind: "error",
    category: "contract-violation",
    rule: "W-6",
  });
  expect(
    binding.buildSnapshot({ seqNr: BigInt(-1), aggregate: {} }),
  ).toMatchObject({ kind: "error", rule: "T-9" });
  expect(
    binding.buildAggregateId({
      typeName: "Order",
      value: "1",
      userString: "ignored",
    }),
  ).toEqual({ kind: "ok", value: "Order-1" });
  expect(binding.validateSeqNrValue(BigInt(0), "value")).toEqual({
    kind: "ok",
    value: BigInt(0),
  });
  expect(binding.validateSeqNrValue(BigInt(0), "event")).toMatchObject({
    kind: "error",
    rule: "W-6",
  });
});

test("serializer shares registry with actual serialization and deserialization stages", () => {
  const registry = new ConformanceFaultRegistry([
    {
      operation: 1,
      phase: "serialize-event",
      kind: "serialization-error",
      injection: "replace-response",
      repeat: { mode: "count", count: 1 },
      details: { message: "failed" },
    },
    {
      operation: 2,
      phase: "deserialize-event",
      kind: "serialization-error",
      injection: "replace-request",
      repeat: { mode: "count", count: 1 },
      details: { message: "restore failed" },
    },
  ]);
  const serializer = binding.serializer(registry, "event");
  const bytes = serializer.serialize({ ok: true });
  expect(serializer.deserialize(bytes, "")).toEqual({ ok: true });
  registry.begin(1);
  expect(() => serializer.serialize({ ok: true })).toThrow("failed");
  registry.finish(1);
  registry.begin(2);
  expect(() => serializer.deserialize(bytes, "")).toThrow("restore failed");
  registry.finish(2);
});
