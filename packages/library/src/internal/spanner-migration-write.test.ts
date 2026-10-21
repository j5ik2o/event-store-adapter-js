import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import type { SpannerMigrationPlan } from "./spanner-migration-plan";
import {
  verifySpannerMigration,
  writeSpannerMigration,
} from "./spanner-migration-write";

const event = (value: string, seqNr: number): EventEnvelope => ({
  aggregateId: { typeName: "Order", value },
  seqNr,
  occurredAt: new Date(0),
  manifest: "m",
  payload: {},
});
const snapshot: SnapshotEnvelope = { seqNr: 2, manifest: "s", aggregate: {} };
const plan: SpannerMigrationPlan<unknown, unknown> = [
  {
    v4AggregateId: "Order-1",
    id: { typeName: "Order", value: "1" },
    events: [event("1", 1), event("1", 2)],
    snapshot,
  },
  {
    v4AggregateId: "Order-2",
    id: { typeName: "Order", value: "2" },
    events: [event("2", 1), event("2", 2)],
    snapshot: undefined,
  },
];

const unused = () => {
  throw new Error("unused");
};
const storeOf = (
  overrides: Partial<EventStore<unknown, unknown>>,
): EventStore<unknown, unknown> => ({
  persistEvent: unused,
  persistEventAndSnapshot: unused,
  getEventsByIdSinceSeqNr: unused,
  getLatestSnapshotById: unused,
  ...overrides,
});

describe("writeSpannerMigration", () => {
  test("reports the counts written before a storage failure", async () => {
    const failure = EventStoreError.storage("boom");
    let calls = 0;
    const store = storeOf({
      persistEvent: async () => {
        calls += 1;
        // 1 集約目の 2 件目はスナップショット付きなので、ここは 1 件目・3 件目・4 件目で呼ばれる。
        return calls === 3 ? Result.err(failure) : Result.ok(undefined);
      },
      persistEventAndSnapshot: async () => Result.ok(undefined),
    });

    const result = await writeSpannerMigration(store, plan);

    expect(result).toEqual({
      type: "err",
      error: {
        error: failure,
        progress: { aggregates: 1, events: 3, snapshots: 1 },
      },
    });
  });

  test("returns the totals when every write succeeds", async () => {
    const store = storeOf({
      persistEvent: async () => Result.ok(undefined),
      persistEventAndSnapshot: async () => Result.ok(undefined),
    });

    const result = await writeSpannerMigration(store, plan);

    expect(result).toMatchObject({
      type: "ok",
      value: { aggregates: 2, events: 4, snapshots: 1 },
    });
  });
});

describe("verifySpannerMigration", () => {
  const readsOf = (
    eventsByValue: Record<string, number[]>,
    head: number,
    snapshotSeqNr: number | undefined,
  ) =>
    storeOf({
      getEventsByIdSinceSeqNr: async (id) =>
        Result.ok(
          (eventsByValue[id.value] ?? []).map((seqNr) =>
            event(id.value, seqNr),
          ),
        ),
      getLatestSnapshotById: async (id) =>
        Result.ok({
          headSeqNr: head,
          ...(id.value === "1" && snapshotSeqNr !== undefined
            ? { snapshot: { ...snapshot, seqNr: snapshotSeqNr } }
            : {}),
        }),
    });

  test("returns no mismatch when the read-back matches the plan", async () => {
    const result = await verifySpannerMigration(
      readsOf({ "1": [1, 2], "2": [1, 2] }, 2, 2),
      plan,
    );
    expect(result).toMatchObject({ type: "ok", value: [] });
  });

  test("reports a missing event, a gap, a wrong head and a wrong snapshot", async () => {
    const result = await verifySpannerMigration(
      readsOf({ "1": [1], "2": [1, 3] }, 1, 1),
      plan,
    );
    if (result.type === "err") throw new Error("unexpected err");
    const byAggregate = (id: string) =>
      result.value.filter((m) => m.aggregateId === id).map((m) => m.reason);
    expect(byAggregate("Order-1")).toEqual([
      expect.stringContaining("expected 2 events but read 1"),
      expect.stringContaining("expected headSeqNr 2 but read 1"),
      expect.stringContaining("expected snapshot seqNr 2 but read 1"),
    ]);
    expect(byAggregate("Order-2")).toEqual([
      expect.stringContaining("not consecutive"),
      expect.stringContaining("expected headSeqNr 2 but read 1"),
    ]);
  });

  test("reports a missing latest snapshot result for every aggregate", async () => {
    const store = storeOf({
      getEventsByIdSinceSeqNr: async (id) =>
        Result.ok([event(id.value, 1), event(id.value, 2)]),
      getLatestSnapshotById: async () => Result.ok(undefined),
    });
    const result = await verifySpannerMigration(store, plan);
    if (result.type === "err") throw new Error("unexpected err");
    expect(result.value.map((m) => m.reason)).toEqual([
      "expected headSeqNr 2 but read undefined",
      "expected snapshot seqNr 2 but read undefined",
      "expected headSeqNr 2 but read undefined",
    ]);
  });

  test("reports a missing snapshot when the head is present", async () => {
    const store = storeOf({
      getEventsByIdSinceSeqNr: async (id) =>
        Result.ok([event(id.value, 1), event(id.value, 2)]),
      getLatestSnapshotById: async () => Result.ok({ headSeqNr: 2 }),
    });
    const result = await verifySpannerMigration(store, plan);
    if (result.type === "err") throw new Error("unexpected err");
    expect(result.value).toEqual([
      {
        aggregateId: "Order-1",
        reason: "expected snapshot seqNr 2 but read undefined",
      },
    ]);
  });

  test("reports a snapshot that the plan does not contain", async () => {
    const store = storeOf({
      getEventsByIdSinceSeqNr: async (id) =>
        Result.ok([event(id.value, 1), event(id.value, 2)]),
      getLatestSnapshotById: async () => Result.ok({ headSeqNr: 2, snapshot }),
    });
    const result = await verifySpannerMigration(store, plan);
    if (result.type === "err") throw new Error("unexpected err");
    expect(result.value).toEqual([
      {
        aggregateId: "Order-2",
        reason: "expected snapshot seqNr undefined but read 2",
      },
    ]);
  });

  test("returns a storage error when the latest snapshot read fails", async () => {
    const failure = EventStoreError.storage("snapshot read failed");
    const store = storeOf({
      getEventsByIdSinceSeqNr: async (id) =>
        Result.ok([event(id.value, 1), event(id.value, 2)]),
      getLatestSnapshotById: async () => Result.err(failure),
    });
    expect(await verifySpannerMigration(store, plan)).toMatchObject({
      type: "err",
      error: failure,
    });
  });

  test("returns a storage error when the read itself fails", async () => {
    const failure = EventStoreError.storage("read failed");
    const store = storeOf({
      getEventsByIdSinceSeqNr: async () => Result.err(failure),
    });
    expect(await verifySpannerMigration(store, plan)).toMatchObject({
      type: "err",
      error: failure,
    });
  });
});
