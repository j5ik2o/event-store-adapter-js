import type { AggregateId } from "../aggregate-id";
import type { Result } from "../result";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { SpannerEventStore } from "../spanner-event-store";
import { migrateV4Spanner } from "../spanner-migration";
import type { SpannerMigrationInput } from "../spanner-migration-input";
import type { SpannerMigrationJournalRow } from "../spanner-migration-journal-row";
import type { SpannerMigrationSnapshotRows } from "../spanner-migration-snapshot-rows";
import { SpannerEmulator } from "./test/spanner-emulator";

const STORE_ID = "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11";
const configuration = {
  store_id: STORE_ID,
  layout_version: 1,
  keep_snapshot_count: null,
  retention_mode: "delete",
  ttl_grace_days: null,
  change_feed_enabled: false,
};

let emulator: SpannerEmulator;
beforeAll(async () => {
  emulator = await SpannerEmulator.start();
}, 240000);
afterAll(async () => {
  await emulator.stop();
}, 60000);

type V4Event = Readonly<{
  aggregateId: string;
  shardId: number;
  seq: number;
  typeName: string;
  value: string;
  /** SQL のリテラル。省略時はミリ秒精度の固定値。 */
  timestamp?: string;
}>;
type V4Snapshot = Readonly<{
  aggregateId: string;
  shardId: number;
  seq: number;
  payload: string;
}>;

const V4_TIMESTAMP = "2026-10-09T00:00:00.123Z";
let scenes = 0;

// v4 の journal / snapshot を、スキーマ文書の v4 の節と同じ DDL で作る。
async function createV4Tables() {
  scenes += 1;
  const journal = `v4_journal_${scenes}`;
  const snapshot = `v4_snapshot_${scenes}`;
  const [operation] = await emulator.database.updateSchema([
    `CREATE TABLE ${journal} (shard_id INT64 NOT NULL, aggregate_id STRING(MAX) NOT NULL, sequence_number INT64 NOT NULL, payload BYTES(MAX) NOT NULL, occurred_at TIMESTAMP NOT NULL) PRIMARY KEY (shard_id, aggregate_id, sequence_number)`,
    `CREATE TABLE ${snapshot} (shard_id INT64 NOT NULL, aggregate_id STRING(MAX) NOT NULL, sequence_number INT64 NOT NULL, version INT64 NOT NULL, payload BYTES(MAX) NOT NULL, updated_at TIMESTAMP NOT NULL) PRIMARY KEY (shard_id, aggregate_id, sequence_number)`,
  ]);
  await operation.promise();
  return { journal, snapshot };
}

const bytes = (text: string) => Buffer.from(text, "utf8");

async function seed(
  tables: { journal: string; snapshot: string },
  events: readonly V4Event[],
  snapshots: readonly V4Snapshot[] = [],
) {
  await emulator.database.runTransactionAsync(async (transaction) => {
    for (const e of events) {
      await transaction.runUpdate({
        sql: `INSERT INTO ${tables.journal} (shard_id, aggregate_id, sequence_number, payload, occurred_at) VALUES (@shard, @aid, @seq, @payload, TIMESTAMP '${e.timestamp ?? V4_TIMESTAMP}')`,
        params: {
          shard: String(e.shardId),
          aid: e.aggregateId,
          seq: String(e.seq),
          payload: bytes(
            JSON.stringify({
              type: `event/${e.seq}`,
              data: { typeName: e.typeName, value: e.value, seq: e.seq },
            }),
          ),
        },
        types: {
          shard: "int64",
          aid: "string",
          seq: "int64",
          payload: "bytes",
        },
      });
    }
    for (const s of snapshots) {
      await transaction.runUpdate({
        sql: `INSERT INTO ${tables.snapshot} (shard_id, aggregate_id, sequence_number, version, payload, updated_at) VALUES (@shard, @aid, @seq, 1, @payload, TIMESTAMP '${V4_TIMESTAMP}')`,
        params: {
          shard: String(s.shardId),
          aid: s.aggregateId,
          seq: String(s.seq),
          payload: bytes(s.payload),
        },
        types: {
          shard: "int64",
          aid: "string",
          seq: "int64",
          payload: "bytes",
        },
      });
    }
    await transaction.commit();
  });
}

async function dump(table: string) {
  const [rows] = await emulator.database.run({
    sql: `SELECT * FROM ${table} ORDER BY shard_id, aggregate_id, sequence_number`,
    json: true,
  });
  return rows;
}

async function count(table: string) {
  const [rows] = await emulator.database.run({
    sql: `SELECT COUNT(*) AS n FROM ${table}`,
    json: true,
  });
  return Number((rows[0] as { n: number }).n);
}

async function targetRowCounts(prefix: string) {
  return {
    journal: await count(`${prefix}_journal`),
    head: await count(`${prefix}_head`),
    snapshotCurrent: await count(`${prefix}_snapshot_current`),
    snapshotHistory: await count(`${prefix}_snapshot_history`),
  };
}

const EMPTY_TARGET = {
  journal: 0,
  head: 0,
  snapshotCurrent: 0,
  snapshotHistory: 0,
};

// v4 の payload は { type, data }。data から型名・値・payload を取り出すのは利用者の復元関数の役目。
const restoreEvent: SpannerMigrationInput<unknown, unknown>["restoreEvent"] = (
  row: SpannerMigrationJournalRow,
) => {
  const parsed = JSON.parse(new TextDecoder().decode(row.payload)) as {
    type: string;
    data: { typeName: string; value: string; seq: number };
  };
  return {
    type: "ok",
    value: {
      typeName: parsed.data.typeName,
      value: parsed.data.value,
      manifest: parsed.type,
      payload: { seq: parsed.data.seq },
    },
  };
};

type Scene = Readonly<{
  tables: { journal: string; snapshot: string };
  prefix: string;
}>;

async function scene(
  events: readonly V4Event[],
  snapshots: readonly V4Snapshot[] = [],
  options: { initialized?: boolean } = {},
): Promise<Scene> {
  const tables = await createV4Tables();
  await seed(tables, events, snapshots);
  const prefix = await emulator.createStore({
    configuration: options.initialized === false ? null : configuration,
  });
  return { tables, prefix };
}

function run(
  s: Scene,
  overrides: Partial<SpannerMigrationInput<unknown, unknown>> = {},
) {
  return migrateV4Spanner<unknown, unknown>({
    database: emulator.database,
    v4Tables: s.tables,
    target: { tablePrefix: s.prefix },
    restoreEvent,
    ...overrides,
  });
}

async function openTarget(prefix: string) {
  const created = await SpannerEventStore.create<unknown, unknown>({
    database: emulator.database,
    tablePrefix: prefix,
  });
  if (created.type === "err") throw new Error(created.error.message);
  return created.value;
}

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.type === "err") {
    throw new Error(`unexpected err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

type Rejected = Extract<
  Awaited<ReturnType<typeof run>> extends Result<unknown, infer F> ? F : never,
  { type: "rejected" }
>;
function rejectionsOf(
  result: Awaited<ReturnType<typeof run>>,
): Rejected["rejections"] {
  if (result.type !== "err" || result.error.type !== "rejected") {
    throw new Error(`expected rejected: ${JSON.stringify(result)}`);
  }
  return result.error.rejections;
}

const ev = (
  aggregateId: string,
  seq: number,
  shardId = 1,
  extra: Partial<V4Event> = {},
): V4Event => {
  const dash = aggregateId.indexOf("-");
  return {
    aggregateId,
    shardId,
    seq,
    typeName: aggregateId.slice(0, dash),
    value: aggregateId.slice(dash + 1),
    ...extra,
  };
};

describe("migrates", () => {
  test("moves events across aggregates and shards plus a snapshot, and reads them back through the public API", async () => {
    const s = await scene(
      [
        ev("Order-1", 1, 1),
        ev("Order-1", 2, 2), // 同じ集約が別の shard にまたがる
        ev("Order-1", 3, 1),
        ev("Order-2", 1, 3),
        ev("Order-2", 2, 3),
      ],
      [
        {
          aggregateId: "Order-1",
          shardId: 1,
          seq: 0,
          payload: '{"s":"latest"}',
        },
        {
          aggregateId: "Order-1",
          shardId: 1,
          seq: 2,
          payload: '{"s":"copy2"}',
        },
      ],
    );
    const restoreSnapshot = jest.fn(
      (rows: SpannerMigrationSnapshotRows): SnapshotEnvelope<unknown> => ({
        seqNr: 2,
        manifest: "snapshot/v1",
        aggregate: { from: rows.aggregateId },
      }),
    );
    const v4Before = {
      journal: await dump(s.tables.journal),
      snapshot: await dump(s.tables.snapshot),
    };

    const report = unwrap(await run(s, { restoreSnapshot }));

    expect(report).toMatchObject({ aggregates: 2, events: 5, snapshots: 1 });
    expect(report.eventsOnlyAggregates).toEqual(["Order-2"]);
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
    const passed = restoreSnapshot.mock.calls[0]?.[0];
    expect(passed?.aggregateId).toBe("Order-1");
    expect(passed?.maxSeqNr).toBe(3);
    expect(passed?.latest).toHaveLength(1);
    expect(passed?.retained).toHaveLength(1);

    const store = await openTarget(s.prefix);
    const id1: AggregateId = { typeName: "Order", value: "1" };
    const events = unwrap(await store.getEventsByIdSinceSeqNr(id1, 1));
    expect(events.map((e) => e.seqNr)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.manifest)).toEqual([
      "event/1",
      "event/2",
      "event/3",
    ]);
    expect(events.map((e) => e.payload)).toEqual([
      { seq: 1 },
      { seq: 2 },
      { seq: 3 },
    ]);
    // 発生時刻はミリ秒のまま。精度を補わない。
    expect(events.map((e) => e.occurredAt.getTime())).toEqual([
      Date.parse(V4_TIMESTAMP),
      Date.parse(V4_TIMESTAMP),
      Date.parse(V4_TIMESTAMP),
    ]);
    const latest = unwrap(await store.getLatestSnapshotById(id1));
    expect(latest?.headSeqNr).toBe(3);
    expect(latest?.snapshot).toEqual({
      seqNr: 2,
      manifest: "snapshot/v1",
      aggregate: { from: "Order-1" },
    });
    const id2: AggregateId = { typeName: "Order", value: "2" };
    const events2 = unwrap(await store.getEventsByIdSinceSeqNr(id2, 1));
    expect(events2.map((e) => e.seqNr)).toEqual([1, 2]);
    expect(unwrap(await store.getLatestSnapshotById(id2))).toMatchObject({
      headSeqNr: 2,
    });

    // v4 のテーブルは読むだけ。
    expect({
      journal: await dump(s.tables.journal),
      snapshot: await dump(s.tables.snapshot),
    }).toEqual(v4Before);
  });
});

describe("type name mapping", () => {
  test("replaces a '-' in the old type name using the mapping", async () => {
    const s = await scene([
      {
        aggregateId: "order-item-1",
        shardId: 1,
        seq: 1,
        typeName: "order-item",
        value: "1",
      },
    ]);

    const report = unwrap(
      await run(s, {
        typeNameMapping: new Map([["order-item", "OrderItem"]]),
      }),
    );

    expect(report.aggregates).toBe(1);
    const store = await openTarget(s.prefix);
    const events = unwrap(
      await store.getEventsByIdSinceSeqNr(
        { typeName: "OrderItem", value: "1" },
        1,
      ),
    );
    expect(events.map((e) => e.seqNr)).toEqual([1]);
  });
});

describe("type name mapping with a custom get", () => {
  test("replaces a '-' using a mapping that only has get", async () => {
    const s = await scene([
      {
        aggregateId: "order-item-1",
        shardId: 1,
        seq: 1,
        typeName: "order-item",
        value: "1",
      },
    ]);

    const report = unwrap(
      await run(s, {
        typeNameMapping: {
          get: (k: string) => (k === "order-item" ? "OrderItem" : undefined),
        } as never,
      }),
    );

    expect(report.aggregates).toBe(1);
    const store = await openTarget(s.prefix);
    const events = unwrap(
      await store.getEventsByIdSinceSeqNr(
        { typeName: "OrderItem", value: "1" },
        1,
      ),
    );
    expect(events.map((e) => e.seqNr)).toEqual([1]);
  });
});

describe("events only", () => {
  const snapshots: V4Snapshot[] = [
    { aggregateId: "Order-1", shardId: 1, seq: 0, payload: '{"s":"latest"}' },
    { aggregateId: "Order-1", shardId: 1, seq: 1, payload: '{"s":"copy"}' },
  ];

  test("moves only events when no snapshot restore function is given", async () => {
    const s = await scene([ev("Order-1", 1), ev("Order-1", 2)], snapshots);

    const report = unwrap(await run(s));

    expect(report).toMatchObject({ aggregates: 1, events: 2, snapshots: 0 });
    expect(report.eventsOnlyAggregates).toEqual(["Order-1"]);
    expect(await targetRowCounts(s.prefix)).toEqual({
      journal: 2,
      head: 1,
      snapshotCurrent: 0,
      snapshotHistory: 0,
    });
  });

  test("moves only events when the restore function declines the aggregate", async () => {
    const s = await scene([ev("Order-1", 1), ev("Order-1", 2)], snapshots);

    const report = unwrap(await run(s, { restoreSnapshot: () => undefined }));

    expect(report).toMatchObject({ aggregates: 1, events: 2, snapshots: 0 });
    expect(report.eventsOnlyAggregates).toEqual(["Order-1"]);
    expect(await targetRowCounts(s.prefix)).toMatchObject({
      snapshotCurrent: 0,
      snapshotHistory: 0,
    });
  });
});

describe("rejects rows", () => {
  async function expectRejectedWithoutWrites(
    events: readonly V4Event[],
    overrides: Partial<SpannerMigrationInput<unknown, unknown>> = {},
  ) {
    const s = await scene(events);
    const v4Before = await dump(s.tables.journal);

    const rejections = rejectionsOf(await run(s, overrides));

    expect(rejections.length).toBeGreaterThan(0);
    for (const r of rejections) {
      expect(typeof r.table).toBe("string");
      expect(r.reason.length).toBeGreaterThan(0);
    }
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
    expect(await dump(s.tables.journal)).toEqual(v4Before);
    return rejections;
  }

  test("a gap in sequence_number", async () => {
    const rejections = await expectRejectedWithoutWrites([
      ev("Order-1", 1),
      ev("Order-1", 3),
    ]);
    expect(rejections.some((r) => r.aggregateId === "Order-1")).toBe(true);
  });

  test("a very large sequence_number is rejected as a gap without exhausting memory", async () => {
    const rejections = await expectRejectedWithoutWrites([
      ev("Order-1", 1),
      ev("Order-1", Number.MAX_SAFE_INTEGER),
    ]);
    expect(
      rejections.filter(
        (r) => r.aggregateId === "Order-1" && r.sequenceNumber === 2,
      ),
    ).toHaveLength(1);
  });

  test("a sequence_number that starts above 1", async () => {
    const rejections = await expectRejectedWithoutWrites([
      ev("Order-1", 2),
      ev("Order-1", 3),
    ]);
    expect(rejections.some((r) => r.aggregateId === "Order-1")).toBe(true);
  });

  test("a duplicate sequence_number across shards", async () => {
    const rejections = await expectRejectedWithoutWrites([
      ev("Order-1", 1, 1),
      ev("Order-1", 2, 1),
      ev("Order-1", 2, 2),
    ]);
    expect(
      rejections.some(
        (r) => r.aggregateId === "Order-1" && r.sequenceNumber === 2,
      ),
    ).toBe(true);
  });

  test("shards that restore to different type names or values", async () => {
    const rejections = await expectRejectedWithoutWrites([
      ev("Order-1", 1, 1),
      { ...ev("Order-1", 2, 2), value: "other" },
    ]);
    expect(rejections.some((r) => r.aggregateId === "Order-1")).toBe(true);
  });

  test("an occurred_at finer than a millisecond", async () => {
    const rejections = await expectRejectedWithoutWrites([
      ev("Order-1", 1),
      ev("Order-1", 2, 1, { timestamp: "2026-10-09T00:00:00.123456Z" }),
    ]);
    expect(
      rejections.some(
        (r) => r.aggregateId === "Order-1" && r.sequenceNumber === 2,
      ),
    ).toBe(true);
  });

  test("a row the restore function refuses, reporting every refused row", async () => {
    const rejections = await expectRejectedWithoutWrites(
      [ev("Order-1", 1), ev("Order-1", 2), ev("Order-2", 1)],
      {
        restoreEvent: (row) =>
          row.sequenceNumber === 1
            ? { type: "err", error: "unknown event layout" }
            : restoreEvent(row),
      },
    );
    expect(rejections.map((r) => r.aggregateId).sort()).toEqual(
      expect.arrayContaining(["Order-1", "Order-2"]),
    );
    expect(
      rejections.some((r) => r.reason.includes("unknown event layout")),
    ).toBe(true);
  });
});

describe("rejects aggregate ids", () => {
  test("moves aggregate ids that do not collide", async () => {
    const s = await scene([ev("Order-1", 1), ev("Order-2", 1)]);

    const report = unwrap(await run(s));

    expect(report.aggregates).toBe(2);
    const store = await openTarget(s.prefix);
    for (const value of ["1", "2"]) {
      const events = unwrap(
        await store.getEventsByIdSinceSeqNr({ typeName: "Order", value }, 1),
      );
      expect(events.map((e) => e.seqNr)).toEqual([1]);
    }
  });

  test("a '-' in the old type name without a mapping entry", async () => {
    const s = await scene([
      {
        aggregateId: "order-item-1",
        shardId: 1,
        seq: 1,
        typeName: "order-item",
        value: "1",
      },
    ]);

    const rejections = rejectionsOf(await run(s));

    expect(rejections.map((r) => r.aggregateId)).toContain("order-item-1");
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("a '-' that remains after the replacement", async () => {
    const s = await scene([
      {
        aggregateId: "order-item-1",
        shardId: 1,
        seq: 1,
        typeName: "order-item",
        value: "1",
      },
    ]);

    const rejections = rejectionsOf(
      await run(s, {
        typeNameMapping: new Map([["order-item", "Order-Item"]]),
      }),
    );

    expect(rejections.map((r) => r.aggregateId)).toContain("order-item-1");
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("two aggregate ids that become the same aggregate id after the mapping", async () => {
    const s = await scene([
      {
        aggregateId: "order-item-1",
        shardId: 1,
        seq: 1,
        typeName: "order-item",
        value: "1",
      },
      {
        aggregateId: "a-1",
        shardId: 1,
        seq: 1,
        typeName: "OrderItem",
        value: "1",
      },
    ]);

    const rejections = rejectionsOf(
      await run(s, { typeNameMapping: new Map([["order-item", "OrderItem"]]) }),
    );

    const ids = rejections.map((r) => r.aggregateId);
    expect(ids).toContain("order-item-1");
    expect(ids).toContain("a-1");
    const counts = await targetRowCounts(s.prefix);
    expect(counts.journal).toBe(0);
    expect(counts.head).toBe(0);
  });

  test("an aggregate id longer than 1024 bytes", async () => {
    const value = "x".repeat(1100);
    const s = await scene([
      {
        aggregateId: `Order-${value}`,
        shardId: 1,
        seq: 1,
        typeName: "Order",
        value,
      },
    ]);

    const rejections = rejectionsOf(await run(s));

    expect(rejections.map((r) => r.aggregateId)).toContain(`Order-${value}`);
    const counts = await targetRowCounts(s.prefix);
    expect(counts.journal).toBe(0);
    expect(counts.head).toBe(0);
  });
});

describe("rejects snapshots", () => {
  test.each([
    ["null", () => null],
    [
      "a value whose seqNr cannot be read",
      () => ({
        get seqNr(): number {
          throw new Error("unreadable");
        },
      }),
    ],
  ])("restoreSnapshot returning %s", async (_name, returned) => {
    const s = await scene(
      [ev("Order-1", 1), ev("Order-1", 2)],
      [{ aggregateId: "Order-1", shardId: 1, seq: 0, payload: '{"s":1}' }],
    );

    const rejections = rejectionsOf(
      await run(s, { restoreSnapshot: (() => returned()) as never }),
    );

    expect(rejections.map((r) => r.aggregateId)).toContain("Order-1");
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  const events = [ev("Order-1", 1), ev("Order-1", 2)];
  const latest: V4Snapshot = {
    aggregateId: "Order-1",
    shardId: 1,
    seq: 0,
    payload: '{"s":1}',
  };
  const snapshotAt = (seqNr: number) => () => ({
    seqNr,
    manifest: "snapshot/v1",
    aggregate: { s: 1 },
  });

  test("a snapshot seq_nr above the aggregate maximum", async () => {
    const s = await scene(events, [latest]);

    const rejections = rejectionsOf(
      await run(s, { restoreSnapshot: snapshotAt(3) }),
    );

    expect(rejections.map((r) => r.aggregateId)).toContain("Order-1");
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("a snapshot seq_nr of 0, which has no corresponding event", async () => {
    const s = await scene(events, [latest]);

    const rejections = rejectionsOf(
      await run(s, { restoreSnapshot: snapshotAt(0) }),
    );

    expect(rejections.map((r) => r.aggregateId)).toContain("Order-1");
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("a snapshot row whose aggregate has no journal rows", async () => {
    const s = await scene(events, [
      latest,
      { aggregateId: "Order-9", shardId: 1, seq: 0, payload: '{"s":9}' },
    ]);

    const rejections = rejectionsOf(
      await run(s, { restoreSnapshot: snapshotAt(2) }),
    );

    expect(rejections.map((r) => r.aggregateId)).toContain("Order-9");
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });
});

describe("rejects targets", () => {
  test("a target that already has data", async () => {
    const s = await scene([ev("Order-1", 1)]);
    const store = await openTarget(s.prefix);
    unwrap(
      await store.persistEvent({
        aggregateId: { typeName: "Existing", value: "1" },
        seqNr: 1,
        occurredAt: new Date(Date.parse(V4_TIMESTAMP)),
        manifest: "event/1",
        payload: {},
      }),
    );
    const before = await targetRowCounts(s.prefix);

    const rejections = rejectionsOf(await run(s));

    expect(rejections.length).toBeGreaterThan(0);
    expect(await targetRowCounts(s.prefix)).toEqual(before);
  });

  test("a target that is not initialized, without creating the config row", async () => {
    const s = await scene([ev("Order-1", 1)], [], { initialized: false });

    const rejections = rejectionsOf(await run(s));

    expect(rejections.length).toBeGreaterThan(0);
    expect(await count(`${s.prefix}_config`)).toBe(0);
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("v4 table names that overlap the target tables", async () => {
    const s = await scene([ev("Order-1", 1)]);

    const rejections = rejectionsOf(
      await run(s, {
        v4Tables: {
          journal: `${s.prefix}_journal`,
          snapshot: s.tables.snapshot,
        },
      }),
    );

    expect(rejections.length).toBeGreaterThan(0);
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });
});

describe("rejects input", () => {
  test.each([
    [
      "v4Tables.journal that is missing",
      (t: Scene["tables"]) => ({ snapshot: t.snapshot }),
    ],
    [
      "v4Tables.journal that is not a string",
      (t: Scene["tables"]) => ({ ...t, journal: 1 }),
    ],
    [
      "v4Tables.snapshot that is not an identifier",
      (t: Scene["tables"]) => ({ ...t, snapshot: "a b" }),
    ],
    [
      "v4Tables.journal longer than 128 characters",
      (t: Scene["tables"]) => ({ ...t, journal: "j".repeat(129) }),
    ],
  ])("%s", async (_name, v4Tables) => {
    const s = await scene([ev("Order-1", 1)]);

    const result = await run(s, { v4Tables: v4Tables(s.tables) as never });

    expect(result).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "configuration-error", fieldName: "v4Tables" },
      },
    });
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("a v4 table name of exactly 128 characters passes the identifier check", async () => {
    const s = await scene([ev("Order-1", 1)]);

    const result = await run(s, {
      v4Tables: { ...s.tables, journal: "j".repeat(128) },
    });

    // 名前の検査を通り、存在しないテーブルの読み取りで storage-error になる。
    expect(result).toMatchObject({
      type: "err",
      error: { type: "error", error: { type: "storage-error" } },
    });
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  }, 30_000);

  test("a typeNameMapping without a get function", async () => {
    const s = await scene([ev("Order-1", 1)]);

    const result = await run(s, { typeNameMapping: {} as never });

    expect(result).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "configuration-error", fieldName: "typeNameMapping" },
      },
    });
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });
});

describe("rejects values returned by user functions", () => {
  test("a mapping entry that is not a string", async () => {
    const s = await scene([
      ev("order-item-1", 1, 1, { typeName: "order-item", value: "1" }),
    ]);

    const rejections = rejectionsOf(
      await run(s, { typeNameMapping: new Map([["order-item", 1]]) as never }),
    );

    expect(rejections.length).toBeGreaterThan(0);
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test.each([
    ["a null value", () => ({ type: "ok", value: null })],
    [
      "a numeric type name",
      () => ({
        type: "ok",
        value: { typeName: 1, value: "1", manifest: "m", payload: {} },
      }),
    ],
    ["an object without a result type", () => ({})],
  ])("restoreEvent returning %s", async (_name, returned) => {
    const s = await scene([ev("Order-1", 1)]);

    const rejections = rejectionsOf(
      await run(s, { restoreEvent: (() => returned()) as never }),
    );

    expect(rejections.length).toBeGreaterThan(0);
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });
  test("a typeNameMapping whose get throws", async () => {
    const s = await scene([
      {
        aggregateId: "order-item-1",
        shardId: 1,
        seq: 1,
        typeName: "order-item",
        value: "1",
      },
    ]);

    const rejections = rejectionsOf(
      await run(s, {
        typeNameMapping: {
          get: () => {
            throw new Error("boom");
          },
        } as never,
      }),
    );

    expect(rejections).toEqual([
      expect.objectContaining({
        aggregateId: "order-item-1",
        reason: "typeNameMapping.get threw: boom",
      }),
    ]);
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test.each(["manifest", "payload"])(
    "restoreEvent returning a value whose %s getter throws",
    async (property) => {
      const s = await scene([ev("Order-1", 1)]);

      const rejections = rejectionsOf(
        await run(s, {
          restoreEvent: (() => ({
            type: "ok",
            value: Object.defineProperties(
              { typeName: "Order", value: "1" },
              {
                manifest: {
                  get: () => {
                    if (property === "manifest") throw new Error("boom");
                    return "m";
                  },
                  enumerable: true,
                },
                payload: {
                  get: () => {
                    if (property === "payload") throw new Error("boom");
                    return {};
                  },
                  enumerable: true,
                },
              },
            ),
          })) as never,
        }),
      );

      expect(rejections).toEqual([
        expect.objectContaining({
          aggregateId: "Order-1",
          shardId: "1",
          sequenceNumber: 1,
          reason: "restoreEvent threw: boom",
        }),
      ]);
      expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
    },
  );

  test("reads each property of the restored event only once", async () => {
    const s = await scene([ev("Order-1", 1)]);
    let typeNameReads = 0;

    const report = unwrap(
      await run(s, {
        restoreEvent: (() => ({
          type: "ok",
          value: {
            get typeName() {
              typeNameReads += 1;
              if (typeNameReads > 1) throw new Error("read again");
              return "Order";
            },
            value: "1",
            manifest: "event/1",
            payload: {},
          },
        })) as never,
      }),
    );

    expect(report.aggregates).toBe(1);
    expect(typeNameReads).toBe(1);
    const store = await openTarget(s.prefix);
    const events = unwrap(
      await store.getEventsByIdSinceSeqNr({ typeName: "Order", value: "1" }, 1),
    );
    expect(events.map((e) => e.seqNr)).toEqual([1]);
  });
});

describe("serializers of the target", () => {
  const serializerOf = (serialize: () => unknown) => ({
    serialize: serialize as never,
    deserialize: () => ({}),
  });
  const withSnapshot = async () =>
    scene(
      [ev("Order-1", 1), ev("Order-1", 2)],
      [{ aggregateId: "Order-1", shardId: 1, seq: 0, payload: '{"s":1}' }],
    );
  const snapshotAt2 = () => ({
    seqNr: 2,
    manifest: "snapshot/v1",
    aggregate: { s: 1 },
  });

  test.each([
    ["returns a string", () => "text", "serializer.serialize must return"],
    [
      "throws",
      () => {
        throw new Error("cannot");
      },
      "cannot",
    ],
  ])("an event serializer that %s rejects the row", async (_n, fn, text) => {
    const s = await scene([ev("Order-1", 1)]);

    const rejections = rejectionsOf(
      await run(s, {
        target: {
          tablePrefix: s.prefix,
          eventSerializer: serializerOf(fn),
        },
      }),
    );

    expect(rejections).toEqual([
      expect.objectContaining({
        aggregateId: "Order-1",
        sequenceNumber: 1,
        reason: expect.stringContaining(
          `payload could not be serialized: ${text}`,
        ),
      }),
    ]);
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test.each([
    ["returns a string", () => "text", "serializer.serialize must return"],
    [
      "throws",
      () => {
        throw new Error("cannot");
      },
      "cannot",
    ],
  ])(
    "a snapshot serializer that %s rejects the aggregate",
    async (_n, fn, text) => {
      const s = await withSnapshot();

      const rejections = rejectionsOf(
        await run(s, {
          restoreSnapshot: snapshotAt2,
          target: {
            tablePrefix: s.prefix,
            snapshotSerializer: serializerOf(fn),
          },
        }),
      );

      expect(rejections).toEqual([
        expect.objectContaining({
          aggregateId: "Order-1",
          reason: expect.stringContaining(
            `snapshot could not be serialized: ${text}`,
          ),
        }),
      ]);
      expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
    },
  );
});

describe("values handed to user functions", () => {
  test("a restoreEvent that changes the occurredAt it received does not change the migrated time", async () => {
    const s = await scene([ev("Order-1", 1)]);

    unwrap(
      await run(s, {
        restoreEvent: (row) => {
          row.occurredAt.setTime(0);
          return restoreEvent(row);
        },
      }),
    );

    const store = await openTarget(s.prefix);
    const events = unwrap(
      await store.getEventsByIdSinceSeqNr({ typeName: "Order", value: "1" }, 1),
    );
    expect(events.map((e) => e.occurredAt.getTime())).toEqual([
      Date.parse(V4_TIMESTAMP),
    ]);
  });
});

describe("snapshot seqNr of the created envelope", () => {
  const events = [ev("Order-1", 1), ev("Order-1", 2)];
  const latest: V4Snapshot = {
    aggregateId: "Order-1",
    shardId: 1,
    seq: 0,
    payload: '{"s":1}',
  };
  // seqNr を読むたびに、先頭の値のあとは 99 を返す。
  const unstable = (first: number) => {
    const reads = { count: 0 };
    return {
      reads,
      restoreSnapshot: () => ({
        get seqNr() {
          reads.count += 1;
          return reads.count === 1 ? first : 99;
        },
        manifest: "snapshot/v1",
        aggregate: { s: 1 },
      }),
    };
  };

  test("reads seqNr once and writes that value", async () => {
    const s = await scene(events, [latest]);
    const { reads, restoreSnapshot } = unstable(2);

    unwrap(await run(s, { restoreSnapshot }));

    expect(reads.count).toBe(1);
    const store = await openTarget(s.prefix);
    const found = unwrap(
      await store.getLatestSnapshotById({ typeName: "Order", value: "1" }),
    );
    expect(found?.snapshot?.seqNr).toBe(2);
  });

  test("checks the range with the value that was read first", async () => {
    const s = await scene(events, [latest]);
    const { reads, restoreSnapshot } = unstable(99);

    const rejections = rejectionsOf(await run(s, { restoreSnapshot }));

    expect(reads.count).toBe(1);
    expect(rejections).toEqual([
      expect.objectContaining({
        aggregateId: "Order-1",
        reason: "snapshot seqNr 99 exceeds the aggregate maximum 2",
      }),
    ]);
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("a restoreSnapshot that throws", async () => {
    const s = await scene(events, [latest]);

    const rejections = rejectionsOf(
      await run(s, {
        restoreSnapshot: () => {
          throw new Error("no snapshot");
        },
      }),
    );

    expect(rejections).toEqual([
      expect.objectContaining({
        reason: "restoreSnapshot threw: no snapshot",
      }),
    ]);
  });

  test("a snapshot row with a negative sequence_number", async () => {
    const s = await scene(events, [{ ...latest, seq: -1 }]);

    const rejections = rejectionsOf(await run(s));

    expect(rejections).toEqual([
      {
        table: s.tables.snapshot,
        aggregateId: "Order-1",
        reason: "invalid snapshot row",
      },
    ]);
  });
});

describe("reads of the input", () => {
  const rawInput = (s: Scene) => ({
    database: emulator.database,
    v4Tables: s.tables,
    target: { tablePrefix: s.prefix },
    restoreEvent,
  });

  test.each([["restoreEvent"], ["v4Tables"], ["target"], ["database"]])(
    "a %s getter that throws is a configuration error",
    async (field) => {
      const s = await scene([ev("Order-1", 1)]);
      const input = Object.defineProperty(rawInput(s), field, {
        get: () => {
          throw new Error("unreadable");
        },
        enumerable: true,
      });

      const result = await migrateV4Spanner(input as never);

      expect(result).toMatchObject({
        type: "err",
        error: {
          type: "error",
          error: {
            type: "configuration-error",
            fieldName: field,
            cause: expect.objectContaining({ message: "unreadable" }),
          },
          progress: { aggregates: 0, events: 0, snapshots: 0 },
        },
      });
      expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
    },
  );

  test("reads every top-level field once", async () => {
    const s = await scene([ev("Order-1", 1)]);
    const reads: Record<string, number> = {};
    const counted = (value: unknown, field: string) => ({
      get: () => {
        reads[field] = (reads[field] ?? 0) + 1;
        return value;
      },
      enumerable: true,
    });
    const base = rawInput(s);
    const input = Object.defineProperties(
      {},
      {
        database: counted(base.database, "database"),
        v4Tables: counted(base.v4Tables, "v4Tables"),
        target: counted(base.target, "target"),
        typeNameMapping: counted(new Map(), "typeNameMapping"),
        restoreEvent: counted(base.restoreEvent, "restoreEvent"),
        restoreSnapshot: counted(undefined, "restoreSnapshot"),
      },
    );

    unwrap(await migrateV4Spanner(input as never));

    expect(reads).toEqual({
      database: 1,
      v4Tables: 1,
      target: 1,
      typeNameMapping: 1,
      restoreEvent: 1,
      restoreSnapshot: 1,
    });
  });

  test.each([[null], ["journal"]])(
    "a v4Tables of %p is a configuration error",
    async (v4Tables) => {
      const s = await scene([ev("Order-1", 1)]);

      expect(await run(s, { v4Tables: v4Tables as never })).toMatchObject({
        type: "err",
        error: {
          type: "error",
          error: { type: "configuration-error", fieldName: "v4Tables" },
        },
      });
      expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
    },
  );

  test("a null input is a configuration error", async () => {
    expect(await migrateV4Spanner(null as never)).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "configuration-error", fieldName: "input" },
      },
    });
  });

  test.each([
    ["restoreEvent", { restoreEvent: "no" }],
    ["restoreSnapshot", { restoreSnapshot: "no" }],
  ])("a %s that is not a function", async (field, overrides) => {
    const s = await scene([ev("Order-1", 1)]);

    expect(await run(s, overrides as never)).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "configuration-error", fieldName: field },
      },
    });
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("a target that the storage rejects is a configuration error", async () => {
    const s = await scene([ev("Order-1", 1)]);

    expect(await run(s, { target: { tablePrefix: "a b" } })).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "configuration-error", fieldName: "tablePrefix" },
      },
    });
  });
});

describe("failures of the database", () => {
  // getTransaction は書き込みだけが使い、getSnapshot は読み取りだけが使う。
  // 呼ばれたかどうかで、書く前と書いた後を見分ける。
  const failing = (
    onSnapshot: (written: boolean) => unknown,
    onTransaction?: () => unknown,
  ) => {
    const state = { written: false };
    const database = new Proxy(emulator.database, {
      get(target, property) {
        if (property === "getTransaction")
          return async (options: never) => {
            state.written = true;
            if (onTransaction !== undefined) return onTransaction();
            return target.getTransaction(options);
          };
        if (property === "getSnapshot")
          return async (options: never) => {
            const replaced = onSnapshot(state.written);
            if (replaced !== undefined) return replaced;
            return target.getSnapshot(options);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return database;
  };

  test("a database that fails to answer at initialization is an error", async () => {
    const s = await scene([ev("Order-1", 1)]);

    const result = await run(s, {
      database: {
        getDatabaseDialect: () => Promise.reject(new Error("down")),
      } as never,
    });

    expect(result).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "storage-error" },
        progress: { aggregates: 0, events: 0, snapshots: 0 },
      },
    });
  });

  test("a failed write is an error with no progress", async () => {
    const s = await scene([ev("Order-1", 1)]);
    const database = failing(
      () => undefined,
      () => Promise.reject(new Error("write down")),
    );

    const result = await run(s, { database });

    expect(result).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "storage-error" },
        progress: { aggregates: 0, events: 0, snapshots: 0 },
      },
    });
    expect(await targetRowCounts(s.prefix)).toEqual(EMPTY_TARGET);
  });

  test("a failed read-back is an error that keeps the written progress", async () => {
    const s = await scene([ev("Order-1", 1)]);
    const database = failing((written) =>
      written ? Promise.reject(new Error("read down")) : undefined,
    );

    const result = await run(s, { database });

    expect(result).toMatchObject({
      type: "err",
      error: {
        type: "error",
        error: { type: "storage-error" },
        progress: { aggregates: 1, events: 1, snapshots: 0 },
      },
    });
  });

  test("a read-back that finds nothing is a verification failure", async () => {
    const s = await scene([ev("Order-1", 1)]);
    const database = failing((written) =>
      written ? [{ run: async () => [[]], end: () => undefined }] : undefined,
    );

    const result = await run(s, { database });

    expect(result).toMatchObject({
      type: "err",
      error: {
        type: "verification-failed",
        mismatches: [
          { aggregateId: "Order-1", reason: "expected 1 events but read 0" },
          {
            aggregateId: "Order-1",
            reason: "expected headSeqNr 1 but read undefined",
          },
        ],
        progress: { aggregates: 1, events: 1, snapshots: 0 },
      },
    });
  });
});
