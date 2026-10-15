import * as path from "node:path";
import type { ConformanceCase } from "./conformance-case";
import {
  executeConformanceCase,
  executeConformanceOperation,
} from "./conformance-case-executor";
import { loadConformanceData } from "./conformance-data-loader";
import type { ConformanceHooks } from "./conformance-hooks";
import { ConformanceMemoryBinding } from "./conformance-memory-binding";
import type { ConformanceStore } from "./conformance-store";

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

const data = loadConformanceData(
  path.resolve(__dirname, "../../../../../../conformance"),
);
const caseOf = (id: string): ConformanceCase => {
  const found = data.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`case ${id} not found`);
  return found;
};

const orderId = { type_name: "Order", value: "1" };
const scenario = (id: string, steps: unknown[]): ConformanceCase => ({
  id,
  rules: ["MEM-2"],
  source: "unit.json",
  format: "scenarios",
  body: {
    fixtures: {
      events: {
        e1: { ...fixtures.events.e, payload: { name: "primary" } },
        f1: { ...fixtures.events.e, payload: { name: "second" } },
      },
      snapshots: {},
    },
    steps,
  } as never,
});
const readFrom = (store: string | undefined, events: string[]) => ({
  op: "getEventsByIdSinceSeqNr",
  arguments: { aggregate_id: orderId, seq_nr: BigInt(1) },
  ...(store === undefined ? {} : { store }),
  expect: { result: "events", events },
});

describe("MEM-2 stores created in the middle of a case", () => {
  test.each(["memory-store-new-independent", "memory-store-shared"])(
    "%s passes with the public memory binding",
    async (id) => {
      const result = await executeConformanceCase(caseOf(id), binding);
      expect(result).toMatchObject({ status: "passed", reason: "" });
    },
  );

  test("routes an operation to the store named by the step and defaults to primary", async () => {
    const result = await executeConformanceCase(
      scenario("route", [
        {
          op: "createStore",
          arguments: { name: "second", storage: "new" },
          expect: { result: "success" },
        },
        {
          op: "persistEvent",
          arguments: { event: "f1" },
          store: "second",
          expect: { result: "success" },
        },
        readFrom("second", ["f1"]),
        readFrom(undefined, []),
      ]),
      binding,
    );
    expect(result).toMatchObject({ status: "passed", reason: "" });
  });

  test("fails when a store is created with the reserved name primary", async () => {
    const result = await executeConformanceCase(
      scenario("reserved", [
        {
          op: "createStore",
          arguments: { name: "primary", storage: "new" },
          expect: { result: "success" },
        },
      ]),
      binding,
    );
    expect(result.status).toBe("failed");
    expect(result.failedOperation).toBe(1);
  });

  test("fails when a store is shared with, or an operation targets, an unregistered name", async () => {
    const shared = await executeConformanceCase(
      scenario("unknown-shared", [
        {
          op: "createStore",
          arguments: {
            name: "second",
            storage: "shared",
            shared_with: "third",
          },
          expect: { result: "success" },
        },
      ]),
      binding,
    );
    expect(shared.status).toBe("failed");
    const targeted = await executeConformanceCase(
      scenario("unknown-target", [readFrom("third", [])]),
      binding,
    );
    expect(targeted.status).toBe("failed");
  });
});

// 保存先の独立性を壊す偽の実装: new を指定されても primary と記録を共有する
class SharingNewStorageBinding extends ConformanceMemoryBinding {
  override async createStore(
    ...args: Parameters<ConformanceMemoryBinding["createStore"]>
  ) {
    const created = await super.createStore(...args);
    const hooks: ConformanceHooks = {
      ...created.hooks,
      createStore: async (request) =>
        created.hooks.createStore?.({
          name: request.name,
          storage: "shared",
          sharedWith: "primary",
        }) as never,
    };
    return { ...created, hooks };
  }
}

test("MEM-2 shares records when a fake store ignores storage new and is reported as failed", async () => {
  const result = await executeConformanceCase(
    caseOf("memory-store-new-independent"),
    new SharingNewStorageBinding(),
  );
  expect(result.status).toBe("failed");
});

// 保存した値を複製せず、封筒が持つペイロードの実体をそのまま返す偽の実装
class UncopiedPayloadBinding extends ConformanceMemoryBinding {
  override async createStore(
    ...args: Parameters<ConformanceMemoryBinding["createStore"]>
  ) {
    const created = await super.createStore(...args);
    if (created.outcome.kind !== "ok") return created;
    const real = created.outcome.value;
    const kept = new Map<string, { payload: unknown }>();
    const store: ConformanceStore<unknown, unknown> = {
      ...real,
      persistEvent: async (event) => {
        kept.set("1", event as { payload: unknown });
        return real.persistEvent(event);
      },
      getEventsByIdSinceSeqNr: async (id, seqNr) => {
        const read = await real.getEventsByIdSinceSeqNr(id, seqNr);
        if (read.kind !== "ok") return read;
        return {
          kind: "ok",
          value: read.value.map((e) => ({
            ...e,
            payload: (kept.get("1")?.payload ?? e.payload) as never,
          })),
        };
      },
    };
    return { ...created, outcome: { kind: "ok" as const, value: store } };
  }
}

test.each(["memory-payload-written-mutation", "memory-payload-read-mutation"])(
  "MEM-6 %s fails when a fake store returns the payload without copying",
  async (id) => {
    const result = await executeConformanceCase(
      caseOf(id),
      new UncopiedPayloadBinding(),
    );
    expect(result.status).toBe("failed");
  },
);

describe("MEM-6 payload isolation", () => {
  test.each([
    "memory-payload-written-mutation",
    "memory-payload-read-mutation",
  ])("%s passes with the public memory binding", async (id) => {
    const result = await executeConformanceCase(caseOf(id), binding);
    expect(result).toMatchObject({ status: "passed", reason: "" });
  });
});
