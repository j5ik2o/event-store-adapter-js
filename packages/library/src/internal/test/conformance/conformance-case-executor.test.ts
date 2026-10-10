import {
  executeConformanceCase,
  executeConformanceOperation,
} from "./conformance-case-executor";
import { ConformanceMemoryBinding } from "./conformance-memory-binding";

const binding = new ConformanceMemoryBinding();
const fixtures = {
  events: {
    e: {
      aggregate_id: { type_name: "Order", value: "1" },
      seq_nr: BigInt(1),
      occurred_at: BigInt(0),
      payload: { name: "Alice" },
    },
  },
  snapshots: { s: { seq_nr: BigInt(1), aggregate: { name: "Alice" } } },
};

test("executes four public operations and captures a construction failure before storage", async () => {
  const created = await binding.createStore({
    config: { retentionMode: "delete", retentionCount: null },
    seedItems: [],
    faults: [],
  });
  if (created.outcome.kind !== "ok") throw new Error("creation failed");
  const store = created.outcome.value;
  expect(
    await executeConformanceOperation(
      binding,
      store,
      {
        op: "persistEventAndSnapshot",
        arguments: { event: "e", snapshot: "s" },
      },
      fixtures,
    ),
  ).toEqual({ kind: "ok", value: undefined });
  expect(
    await executeConformanceOperation(
      binding,
      store,
      {
        op: "getEventsByIdSinceSeqNr",
        arguments: {
          aggregate_id: fixtures.events.e.aggregate_id,
          seq_nr: BigInt(1),
        },
      },
      fixtures,
    ),
  ).toMatchObject({
    kind: "ok",
    value: [{ payload: { name: "Alice" }, seqNr: BigInt(1) }],
  });
  expect(
    await executeConformanceOperation(
      binding,
      store,
      {
        op: "getLatestSnapshotById",
        arguments: { aggregate_id: fixtures.events.e.aggregate_id },
      },
      fixtures,
    ),
  ).toMatchObject({
    kind: "ok",
    value: { headSeqNr: BigInt(1), snapshot: { seqNr: BigInt(1) } },
  });
  const invalid = {
    ...fixtures,
    events: { e: { ...fixtures.events.e, seq_nr: BigInt(-1) } },
  };
  expect(
    await executeConformanceOperation(
      binding,
      store,
      { op: "persistEvent", arguments: { event: "e" } },
      invalid,
    ),
  ).toMatchObject({ kind: "error", rule: "T-9" });
  await created.dispose();
});

test("reports incorrect expectations as failed with direct evidence and failed operation", async () => {
  const result = await executeConformanceCase(
    {
      id: "unit",
      rules: ["R-6"],
      source: "unit.json",
      format: "scenarios",
      body: {
        fixtures,
        steps: [
          {
            op: "persistEvent",
            arguments: { event: "e" },
            expect: { result: "success" },
          },
          {
            op: "getEventsByIdSinceSeqNr",
            arguments: {
              aggregate_id: fixtures.events.e.aggregate_id,
              seq_nr: BigInt(1),
            },
            expect: { result: "events", events: [] },
          },
        ],
      },
    },
    binding,
  );
  expect(result.status).toBe("failed");
  expect(result.failedOperation).toBe(2);
  expect(result.actual).toMatchObject({
    kind: "ok",
    value: [{ payload: { name: "Alice" } }],
  });
  expect(result.evidence).toBeDefined();
});
