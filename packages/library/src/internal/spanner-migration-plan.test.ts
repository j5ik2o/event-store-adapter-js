import { PayloadSerializer } from "../payload-serializer";
import type { SpannerMigrationInput } from "../spanner-migration-input";
import { planSpannerMigration } from "./spanner-migration-plan";

const serializers = {
  eventSerializer: PayloadSerializer.json<unknown>(),
  snapshotSerializer: PayloadSerializer.json<unknown>(),
};
const input: SpannerMigrationInput<unknown, unknown> = {
  database: {} as never,
  v4Tables: { journal: "journal", snapshot: "snapshot" },
  target: { tablePrefix: "esa" },
  restoreEvent: () => ({
    type: "ok",
    value: { typeName: "Order", value: "1", manifest: "m", payload: {} },
  }),
};
const journalRow = (overrides: Record<string, unknown> = {}) => ({
  aggregate_id: "Order-1",
  shard_id: "1",
  sequence_number: "1",
  millisecond_precision: true,
  occurred_at_ms: "0",
  payload: new Uint8Array([1]),
  ...overrides,
});
const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
  aggregate_id: "Order-1",
  shard_id: "1",
  sequence_number: "0",
  version: "1",
  payload: new Uint8Array([1]),
  ...overrides,
});
const plan = (
  journal: readonly Record<string, unknown>[],
  snapshots: readonly Record<string, unknown>[] = [],
  overrides: Partial<SpannerMigrationInput<unknown, unknown>> = {},
) =>
  planSpannerMigration(
    { journal, snapshots, populatedTargetTables: [] },
    { ...input, ...overrides },
    serializers,
  );
const rejectionsOf = (result: ReturnType<typeof plan>) => {
  if (result.type === "ok") throw new Error("expected err");
  return result.error;
};

describe("planSpannerMigration journal rows", () => {
  test("a valid row is planned", () => {
    expect(plan([journalRow()])).toMatchObject({
      type: "ok",
      value: [{ v4AggregateId: "Order-1", events: [{ seqNr: 1 }] }],
    });
  });

  test.each([
    [
      "an aggregate_id that is not a string",
      { aggregate_id: 1 },
      { table: "journal", reason: "invalid aggregate_id or shard_id" },
    ],
    [
      "a shard_id that is not an integer",
      { shard_id: "x" },
      {
        table: "journal",
        aggregateId: "Order-1",
        reason: "invalid aggregate_id or shard_id",
      },
    ],
    [
      "a sequence_number of 0",
      { sequence_number: "0" },
      {
        aggregateId: "Order-1",
        shardId: "1",
        reason: "sequence_number must be 1 or greater",
      },
    ],
    [
      "an occurred_at_ms that is not an integer",
      { occurred_at_ms: "x" },
      {
        aggregateId: "Order-1",
        sequenceNumber: 1,
        reason: "invalid occurred_at or payload",
      },
    ],
    [
      "a payload that is not bytes",
      { payload: "text" },
      {
        aggregateId: "Order-1",
        sequenceNumber: 1,
        reason: "invalid occurred_at or payload",
      },
    ],
  ])("rejects %s", (_name, overrides, expected) => {
    const rejections = rejectionsOf(plan([journalRow(overrides)]));

    expect(rejections).toEqual([expect.objectContaining(expected)]);
    if (typeof overrides === "object" && "aggregate_id" in overrides) {
      expect(rejections[0]).not.toHaveProperty("aggregateId");
    }
  });
});

describe("planSpannerMigration snapshot rows", () => {
  test.each([
    ["an aggregate_id that is not a string", { aggregate_id: 1 }, false],
    ["a sequence_number below 0", { sequence_number: "-1" }, true],
  ])("rejects %s", (_name, overrides, hasAggregateId) => {
    const rejections = rejectionsOf(
      plan([journalRow()], [snapshotRow(overrides)]),
    );

    expect(rejections).toEqual([
      {
        table: "snapshot",
        ...(hasAggregateId ? { aggregateId: "Order-1" } : {}),
        reason: "invalid snapshot row",
      },
    ]);
  });
});

describe("planSpannerMigration user functions", () => {
  test("a restoreEvent that throws a value that is not an Error", () => {
    const rejections = rejectionsOf(
      plan([journalRow()], [], {
        restoreEvent: () => {
          throw "plain text";
        },
      }),
    );

    expect(rejections).toEqual([
      expect.objectContaining({ reason: "restoreEvent threw: plain text" }),
    ]);
  });

  test("a restoreEvent whose manifest is not a string fails the event envelope", () => {
    const rejections = rejectionsOf(
      plan([journalRow()], [], {
        restoreEvent: () => ({
          type: "ok",
          value: { typeName: "Order", value: "1", manifest: 1, payload: {} },
        }),
      } as never),
    );

    expect(rejections).toEqual([
      expect.objectContaining({ aggregateId: "Order-1", sequenceNumber: 1 }),
    ]);
  });

  test("a restoreSnapshot that throws", () => {
    const rejections = rejectionsOf(
      plan([journalRow()], [snapshotRow()], {
        restoreSnapshot: () => {
          throw new Error("no snapshot");
        },
      }),
    );

    expect(rejections).toEqual([
      expect.objectContaining({
        aggregateId: "Order-1",
        reason: "restoreSnapshot threw: no snapshot",
      }),
    ]);
  });

  test("a restoreSnapshot whose value has no aggregate fails the snapshot envelope", () => {
    const rejections = rejectionsOf(
      plan([journalRow()], [snapshotRow()], {
        restoreSnapshot: () => ({ seqNr: 1, manifest: "s" }),
      } as never),
    );

    expect(rejections).toEqual([
      expect.objectContaining({ aggregateId: "Order-1" }),
    ]);
  });
});
