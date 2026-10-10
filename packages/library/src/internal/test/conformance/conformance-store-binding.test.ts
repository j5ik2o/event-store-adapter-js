import type { ConformanceStoreBinding } from "./conformance-store-binding";

describe("ConformanceStoreBinding construction inputs", () => {
  test("accepts event and snapshot inputs without manifest and checks seqNr in a value context", () => {
    const binding: ConformanceStoreBinding<unknown, unknown> = {
      backend: "memory",
      createStore: jest.fn(),
      buildAggregateId: jest.fn(),
      buildEvent: jest.fn(() => ({ kind: "ok" as const, value: "e" })),
      buildSnapshot: jest.fn(() => ({ kind: "ok" as const, value: "s" })),
      validateSeqNrValue: jest.fn((seqNr: bigint) => ({
        kind: "ok" as const,
        value: seqNr,
      })),
    };

    const event = binding.buildEvent({
      aggregateId: { typeName: "t", value: "v" },
      seqNr: BigInt(1),
      occurredAtEpochNanos: BigInt(0),
      payload: null,
    });
    const snapshot = binding.buildSnapshot({
      seqNr: BigInt(0),
      aggregate: null,
    });

    expect(event).toEqual({ kind: "ok", value: "e" });
    expect(snapshot).toEqual({ kind: "ok", value: "s" });
    expect(binding.validateSeqNrValue(BigInt(0))).toEqual({
      kind: "ok",
      value: BigInt(0),
    });
  });
});
