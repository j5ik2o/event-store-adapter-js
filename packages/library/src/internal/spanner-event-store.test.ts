import type { AggregateId } from "../aggregate-id";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import type { EventStoreError } from "../event-store-error";
import type { Result } from "../result";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { SpannerEventStore } from "../spanner-event-store";
import type { SpannerEventStoreInput } from "../spanner-event-store-input";
import { initializeSpannerEventStoreInternal } from "./spanner-event-store";
import type { SpannerEventStoreHooks } from "./spanner-event-store-hooks";
import {
  SpannerEmulator,
  type SpannerSeedConfiguration,
} from "./test/spanner-emulator";

const STORE_ID = "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11";
const configuration = (
  overrides: Partial<SpannerSeedConfiguration> = {},
): SpannerSeedConfiguration => ({
  store_id: STORE_ID,
  layout_version: 1,
  keep_snapshot_count: null,
  retention_mode: "delete",
  ttl_grace_days: null,
  change_feed_enabled: false,
  ...overrides,
});
const aborted = () => Object.assign(new Error("aborted"), { code: 10 });
const id = (value: string): AggregateId => ({ typeName: "Order", value });
const millis = Date.parse("2026-10-09T00:00:00.123Z");
const eventOf = (value: string, seqNr: number): EventEnvelope => ({
  aggregateId: id(value),
  seqNr,
  occurredAt: new Date(millis),
  manifest: "event/v1",
  payload: { seqNr },
});
const snapshotOf = (seqNr: number): SnapshotEnvelope => ({
  seqNr,
  manifest: "snapshot/v1",
  aggregate: { seqNr },
});

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message);
  return result.value;
}

let emulator: SpannerEmulator;
beforeAll(async () => {
  emulator = await SpannerEmulator.start();
}, 240000);
afterAll(async () => {
  await emulator.stop();
}, 60000);

async function count(prefix: string, table: string, where = "TRUE") {
  const [rows] = await emulator.database.run({
    sql: `SELECT COUNT(*) AS n FROM ${prefix}_${table} WHERE ${where}`,
    json: true,
  });
  return Number((rows[0] as { n: number }).n);
}

async function open(
  setup: Parameters<SpannerEmulator["createStore"]>[0],
  input: Partial<SpannerEventStoreInput<unknown, unknown>> = {},
  hooks?: SpannerEventStoreHooks,
) {
  const prefix = await emulator.createStore(setup);
  const created = await initializeSpannerEventStoreInternal(
    { database: emulator.database, tablePrefix: prefix, ...input },
    hooks,
  );
  return { prefix, created };
}

const plain = { configuration: configuration() };

describe("create", () => {
  test("the public entry returns a frozen object with the four operations", async () => {
    const prefix = await emulator.createStore(plain);
    const created = await SpannerEventStore.create({
      database: emulator.database,
      tablePrefix: prefix,
    });
    const store = unwrap(created);
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.keys(store).sort()).toEqual([
      "getEventsByIdSinceSeqNr",
      "getLatestSnapshotById",
      "persistEvent",
      "persistEventAndSnapshot",
    ]);
  });

  test("does not run DDL or create the missing config row", async () => {
    const prefix = await emulator.createStore({ configuration: null });
    const created = await SpannerEventStore.create({
      database: emulator.database,
      tablePrefix: prefix,
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(await count(prefix, "config")).toBe(0);
  });

  test("a missing table is a configuration error", async () => {
    const created = await SpannerEventStore.create({
      database: emulator.database,
      tablePrefix: "no_such_store",
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test.each([
    ["layout_version 2", configuration({ layout_version: 2 }), {}],
    [
      "a different keep_snapshot_count",
      configuration({ keep_snapshot_count: 2 }),
      { retention: { count: 1 } },
    ],
    [
      "a different retention_mode",
      configuration({ retention_mode: "ttl", ttl_grace_days: 7 }),
      {},
    ],
    [
      "change_feed_enabled true",
      configuration({ change_feed_enabled: true }),
      {},
    ],
    ["an invalid store_id", configuration({ store_id: "NOT-A-UUID" }), {}],
    ["ttl_grace_days set for delete", configuration({ ttl_grace_days: 7 }), {}],
    [
      "an unknown retention_mode",
      configuration({ retention_mode: "archive" }),
      {},
    ],
    [
      "a zero keep_snapshot_count",
      configuration({ keep_snapshot_count: 0 }),
      {},
    ],
  ] as const)(
    "rejects a recorded configuration with %s",
    async (_, seeded, input) => {
      const { created } = await open({ configuration: seeded }, input);
      expect(created).toMatchObject({
        type: "err",
        error: { type: "configuration-error" },
      });
    },
  );

  test("rejects a delete store whose snapshot_history has a row deletion policy", async () => {
    const { created } = await open({
      configuration: configuration(),
      rowDeletionPolicyDays: 7,
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "retention" },
    });
  });

  test("SPN-16 accepts a ttl store whose three graceDays agree", async () => {
    const { created } = await open(
      {
        configuration: configuration({
          keep_snapshot_count: 1,
          retention_mode: "ttl",
          ttl_grace_days: 7,
        }),
        rowDeletionPolicyDays: 7,
      },
      { retention: { count: 1, mode: { type: "ttl", graceDays: 7 } } },
    );
    expect(created.type).toBe("ok");
  });

  test.each([
    ["the recorded configuration", 8, 7, 7],
    ["the row deletion policy", 7, 8, 7],
    ["the client", 7, 7, 6],
  ])(
    "SPN-16 rejects a ttl store whose %s differs",
    async (_, recorded, policy, client) => {
      const { created } = await open(
        {
          configuration: configuration({
            keep_snapshot_count: 1,
            retention_mode: "ttl",
            ttl_grace_days: recorded,
          }),
          rowDeletionPolicyDays: policy,
        },
        { retention: { count: 1, mode: { type: "ttl", graceDays: client } } },
      );
      expect(created).toMatchObject({
        type: "err",
        error: { type: "configuration-error" },
      });
    },
  );

  test("rejects a ttl store without a row deletion policy", async () => {
    const { created } = await open(
      {
        configuration: configuration({
          keep_snapshot_count: 1,
          retention_mode: "ttl",
          ttl_grace_days: 7,
        }),
      },
      { retention: { count: 1, mode: { type: "ttl", graceDays: 7 } } },
    );
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "retention" },
    });
  });

  test("SPN-17 rejects a request for a change feed", async () => {
    const { created } = await open(plain, { changeFeed: true });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "changeFeed" },
    });
  });

  test("a prefix with a different table layout is a configuration error", async () => {
    const prefix = await emulator.createStore(plain);
    const [operation] = await emulator.database.updateSchema([
      `ALTER TABLE ${prefix}_head DROP COLUMN event_payload`,
    ]);
    await operation.promise();
    const created = await SpannerEventStore.create({
      database: emulator.database,
      tablePrefix: prefix,
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "tablePrefix" },
    });
  });

  test("a database that fails to answer is a storage error", async () => {
    const created = await SpannerEventStore.create({
      database: {
        getDatabaseDialect: () => Promise.reject(new Error("down")),
      } as never,
      tablePrefix: "esa",
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });
});

async function plainStore(
  input: Partial<SpannerEventStoreInput<unknown, unknown>> = {},
  hooks?: SpannerEventStoreHooks,
  setup: Parameters<SpannerEmulator["createStore"]>[0] = plain,
) {
  const { prefix, created } = await open(setup, input, hooks);
  return { prefix, store: unwrap(created) as EventStore };
}

describe("persist", () => {
  test("seq_nr 1 creates the journal and head rows in one commit", async () => {
    const { prefix, store } = await plainStore();
    expect(unwrap(await store.persistEvent(eventOf("1", 1)))).toBeUndefined();
    expect(await count(prefix, "journal")).toBe(1);
    expect(await count(prefix, "head")).toBe(1);
    expect(await count(prefix, "snapshot_current")).toBe(0);
    expect(await count(prefix, "snapshot_history")).toBe(0);
  });

  test("appends in order and keeps the previous journal rows", async () => {
    const { prefix, store } = await plainStore();
    for (const seqNr of [1, 2, 3])
      unwrap(await store.persistEvent(eventOf("1", seqNr)));
    expect(await count(prefix, "journal")).toBe(3);
    expect(await count(prefix, "head")).toBe(1);
    const events = unwrap(await store.getEventsByIdSinceSeqNr(id("1"), 1));
    expect(events.map((e) => e.seqNr)).toEqual([1, 2, 3]);
    expect(events[0].occurredAt.getTime()).toBe(millis);
  });

  test("an existing head makes seq_nr 1 an optimistic lock conflict", async () => {
    const { store } = await plainStore();
    unwrap(await store.persistEvent(eventOf("1", 1)));
    expect(await store.persistEvent(eventOf("1", 1))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", headSeqNr: 1 },
    });
  });

  test("a seq_nr at or below the head conflicts", async () => {
    const { store } = await plainStore();
    for (const seqNr of [1, 2])
      unwrap(await store.persistEvent(eventOf("1", seqNr)));
    expect(await store.persistEvent(eventOf("1", 2))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", headSeqNr: 2 },
    });
  });

  test("a skipped seq_nr is a W-8 contract violation and writes nothing", async () => {
    const { prefix, store } = await plainStore();
    expect(await store.persistEvent(eventOf("1", 3))).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-8" },
    });
    expect(await count(prefix, "journal")).toBe(0);
    unwrap(await store.persistEvent(eventOf("1", 1)));
    expect(await store.persistEvent(eventOf("1", 3))).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-8" },
    });
  });

  test("a snapshot with a different seq_nr is a W-9 contract violation", async () => {
    const { store } = await plainStore();
    expect(
      await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(2)),
    ).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-9" },
    });
  });

  test("a snapshot writes snapshot_current, and history only with a retention", async () => {
    const { prefix, store } = await plainStore();
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)));
    expect(await count(prefix, "snapshot_current")).toBe(1);
    expect(await count(prefix, "snapshot_history")).toBe(0);
    const kept = await plainStore({ retention: { count: 3 } }, undefined, {
      configuration: configuration({ keep_snapshot_count: 3 }),
    });
    unwrap(
      await kept.store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)),
    );
    expect(
      await count(kept.prefix, "snapshot_history", "expired_at IS NULL"),
    ).toBe(1);
  });

  test("an event after a snapshot replaces nothing in snapshot_current", async () => {
    const { prefix, store } = await plainStore();
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)));
    unwrap(await store.persistEvent(eventOf("1", 2)));
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 3), snapshotOf(3)));
    expect(await count(prefix, "snapshot_current")).toBe(1);
    const latest = unwrap(await store.getLatestSnapshotById(id("1")));
    expect(latest).toMatchObject({ headSeqNr: 3, snapshot: { seqNr: 3 } });
  });

  test("a serializer failure writes nothing", async () => {
    const { prefix, store } = await plainStore({
      eventSerializer: {
        serialize: () => {
          throw new Error("boom");
        },
        deserialize: () => ({}),
      },
    });
    expect(await store.persistEvent(eventOf("1", 1))).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "serialize" },
    });
    expect(await count(prefix, "journal")).toBe(0);
  });

  test("a snapshot serializer failure writes nothing", async () => {
    const { prefix, store } = await plainStore({
      snapshotSerializer: {
        serialize: () => {
          throw new Error("boom");
        },
        deserialize: () => ({}),
      },
    });
    expect(
      await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)),
    ).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "serialize" },
    });
    expect(await count(prefix, "head")).toBe(0);
  });

  test("a storage failure is a storage error, not a lock conflict", async () => {
    const { prefix, store } = await plainStore(
      {},
      {
        beforeCommit: () => {
          throw new Error("down");
        },
      },
    );
    expect(await store.persistEvent(eventOf("1", 1))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(await count(prefix, "journal")).toBe(0);
  });

  test("keeps an aggregate whose id is a prefix of another separate", async () => {
    const { store } = await plainStore();
    unwrap(await store.persistEvent(eventOf("1", 1)));
    unwrap(await store.persistEvent(eventOf("10", 1)));
    const events = unwrap(await store.getEventsByIdSinceSeqNr(id("1"), 1));
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toEqual(id("1"));
  });
});

describe("SPN-8 response lost", () => {
  test("is an unknown-outcome storage error; a resend is an optimistic lock conflict", async () => {
    let lose = true;
    const { prefix, store } = await plainStore(
      {},
      {
        afterCommit: () => {
          if (!lose) return;
          lose = false;
          throw new Error("STORAGE_SENTINEL");
        },
      },
    );
    const first = await store.persistEvent(eventOf("Order-9", 1));
    expect(first).toMatchObject({
      type: "err",
      error: {
        type: "storage-error",
        message: expect.stringContaining("unknown"),
      },
    });
    // 補償の書き込みをせず、確定した行はそのまま残る
    expect(await count(prefix, "journal")).toBe(1);
    expect(await count(prefix, "head")).toBe(1);
    const second = await store.persistEvent(eventOf("Order-9", 1));
    expect(second).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict" },
    });
    if (second.type !== "err") throw new Error("expected error");
    expect(second.error.message).toContain("Order-Order-9");
    expect(second.error.message).toContain("1");
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(id("Order-9"), 1)),
    ).toHaveLength(1);
  });
});

describe("SPN-7 aborted retry", () => {
  const abortTimes = (times: number): SpannerEventStoreHooks => {
    let remaining = times;
    return {
      beforeCommit: () => {
        if (remaining === 0) return;
        remaining -= 1;
        throw aborted();
      },
    };
  };

  test("retries up to the limit with the same envelope and keeps one row", async () => {
    const { prefix, store } = await plainStore(
      { transactionRetryLimit: 3 },
      abortTimes(2),
    );
    unwrap(await store.persistEvent(eventOf("1", 1)));
    expect(await count(prefix, "journal")).toBe(1);
    const events = unwrap(await store.getEventsByIdSinceSeqNr(id("1"), 1));
    expect(events).toHaveLength(1);
    expect(events[0].seqNr).toBe(1);
  });

  test("beyond the limit is a storage error and nothing is committed", async () => {
    const { prefix, store } = await plainStore(
      { transactionRetryLimit: 2 },
      abortTimes(3),
    );
    expect(await store.persistEvent(eventOf("1", 1))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(await count(prefix, "journal")).toBe(0);
    expect(await count(prefix, "head")).toBe(0);
    unwrap(await store.persistEvent(eventOf("1", 1)));
  });

  test("a retry after a competing append committed is an optimistic lock conflict", async () => {
    const prefix = await emulator.createStore(plain);
    const other = unwrap(
      await initializeSpannerEventStoreInternal({
        database: emulator.database,
        tablePrefix: prefix,
      }),
    );
    let attempts = 0;
    // エミュレーターは読み書きトランザクションの重なりを許さないので、
    // 中断の後・次の試行の前に、同じ seq_nr の追記を確定させる。
    const database = new Proxy(emulator.database, {
      get(target, property) {
        if (property === "getTransaction")
          return async (options: never) => {
            attempts += 1;
            if (attempts === 2)
              unwrap(await other.persistEvent(eventOf("1", 1)));
            return target.getTransaction(options);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = unwrap(
      await initializeSpannerEventStoreInternal(
        { database, tablePrefix: prefix },
        {
          beforeCommit: () => {
            if (attempts === 1) throw aborted();
          },
        },
      ),
    );
    expect(await store.persistEvent(eventOf("1", 1))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", headSeqNr: 1 },
    });
    expect(attempts).toBe(2);
  });
});

describe("read", () => {
  test("an unknown aggregate has no snapshot and no events", async () => {
    const { store } = await plainStore();
    expect(unwrap(await store.getLatestSnapshotById(id("x")))).toBeUndefined();
    expect(unwrap(await store.getEventsByIdSinceSeqNr(id("x"), 0))).toEqual([]);
  });

  test("a head without a snapshot returns only the head position", async () => {
    const { store } = await plainStore();
    unwrap(await store.persistEvent(eventOf("1", 1)));
    expect(unwrap(await store.getLatestSnapshotById(id("1")))).toEqual({
      headSeqNr: 1,
    });
  });

  test("reads max(1, seqNr)..head in order; beyond the head is empty", async () => {
    const { store } = await plainStore();
    for (const seqNr of [1, 2, 3])
      unwrap(await store.persistEvent(eventOf("1", seqNr)));
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(id("1"), 0)).map(
        (e) => e.seqNr,
      ),
    ).toEqual([1, 2, 3]);
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(id("1"), 2)).map(
        (e) => e.seqNr,
      ),
    ).toEqual([2, 3]);
    expect(unwrap(await store.getEventsByIdSinceSeqNr(id("1"), 4))).toEqual([]);
  });

  test("a gap in the journal range is a storage error", async () => {
    const { prefix, store } = await plainStore();
    for (const seqNr of [1, 2, 3])
      unwrap(await store.persistEvent(eventOf("1", seqNr)));
    await emulator.database.runTransactionAsync(async (transaction) => {
      await transaction.runUpdate({
        sql: `DELETE FROM ${prefix}_journal WHERE seq_nr = 2`,
      });
      await transaction.commit();
    });
    expect(await store.getEventsByIdSinceSeqNr(id("1"), 1)).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });

  test("a snapshot newer than the head is a storage error", async () => {
    const { prefix, store } = await plainStore();
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)));
    await emulator.database.runTransactionAsync(async (transaction) => {
      await transaction.runUpdate({
        sql: `UPDATE ${prefix}_snapshot_current SET seq_nr = 5 WHERE TRUE`,
      });
      await transaction.commit();
    });
    expect(await store.getLatestSnapshotById(id("1"))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });

  test("a deserialization failure is a serialization error", async () => {
    const { store } = await plainStore({
      eventSerializer: {
        serialize: () => new Uint8Array([1]),
        deserialize: () => {
          throw new Error("bad");
        },
      },
      snapshotSerializer: {
        serialize: () => new Uint8Array([1]),
        deserialize: () => {
          throw new Error("bad");
        },
      },
    });
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)));
    expect(await store.getEventsByIdSinceSeqNr(id("1"), 1)).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "deserialize" },
    });
    expect(await store.getLatestSnapshotById(id("1"))).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "deserialize" },
    });
  });

  test("a storage failure while reading is a storage error", async () => {
    const { store } = await plainStore(
      {},
      {
        beforeReadEvents: () => {
          throw new Error("down");
        },
        beforeReadSnapshot: () => {
          throw new Error("down");
        },
      },
    );
    expect(await store.getEventsByIdSinceSeqNr(id("1"), 1)).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(await store.getLatestSnapshotById(id("1"))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });
});

describe("retention", () => {
  const deleteSetup = (keep: number) => ({
    configuration: configuration({ keep_snapshot_count: keep }),
  });
  const ttlSetup = (keep: number) => ({
    configuration: configuration({
      keep_snapshot_count: keep,
      retention_mode: "ttl",
      ttl_grace_days: 7,
    }),
    rowDeletionPolicyDays: 7,
  });
  const ttl = {
    retention: { count: 1, mode: { type: "ttl", graceDays: 7 } },
  } as const;

  async function history(prefix: string) {
    const [rows] = await emulator.database.run({
      sql: `SELECT seq_nr, expired_at IS NULL AS active FROM ${prefix}_snapshot_history ORDER BY seq_nr`,
      json: true,
    });
    return (rows as { seq_nr: number; active: boolean }[]).map((row) => [
      Number(row.seq_nr),
      row.active,
    ]);
  }

  test("delete mode keeps the newest n history rows and never touches journal, head or current", async () => {
    const { prefix, store } = await plainStore(
      { retention: { count: 2 } },
      undefined,
      deleteSetup(2),
    );
    for (const seqNr of [1, 2, 3, 4])
      unwrap(
        await store.persistEventAndSnapshot(
          eventOf("1", seqNr),
          snapshotOf(seqNr),
        ),
      );
    expect(await history(prefix)).toEqual([
      [3, true],
      [4, true],
    ]);
    expect(await count(prefix, "journal")).toBe(4);
    expect(await count(prefix, "head")).toBe(1);
    expect(await count(prefix, "snapshot_current")).toBe(1);
  });

  test("ttl mode marks old rows once, does not count marked rows and does not re-select them", async () => {
    const { prefix, store } = await plainStore(ttl, undefined, ttlSetup(1));
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)));
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 2), snapshotOf(2)));
    const first = await emulator.database.run({
      sql: `SELECT seq_nr, expired_at FROM ${prefix}_snapshot_history WHERE seq_nr = 1`,
      json: true,
    });
    const marked = (first[0][0] as { expired_at: unknown }).expired_at;
    expect(marked).not.toBeNull();
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 3), snapshotOf(3)));
    expect(await history(prefix)).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    const again = await emulator.database.run({
      sql: `SELECT expired_at FROM ${prefix}_snapshot_history WHERE seq_nr = 1`,
      json: true,
    });
    expect(String((again[0][0] as { expired_at: unknown }).expired_at)).toBe(
      String(marked),
    );
  });

  test("a retention failure is notified once and the append still succeeds", async () => {
    const failures: unknown[] = [];
    const errors: unknown[] = [];
    const { prefix, store } = await plainStore(
      {
        retention: { count: 1 },
        onRetentionFailure: (failure) => failures.push(failure),
        logger: {
          ...console,
          error: (...args: unknown[]) => errors.push(args),
        },
      },
      {
        beforeRetentionDelete: () => {
          throw new Error("RETENTION_FAILURE");
        },
      },
      deleteSetup(1),
    );
    unwrap(await store.persistEventAndSnapshot(eventOf("1", 1), snapshotOf(1)));
    expect(
      await store.persistEventAndSnapshot(eventOf("1", 2), snapshotOf(2)),
    ).toEqual({ type: "ok", value: undefined });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "retention-failure",
      aggregateId: "Order-1",
    });
    expect(await history(prefix)).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  test("a replaced history listing selects candidates from the listed rows only", async () => {
    const { prefix, store } = await plainStore(
      { retention: { count: 1 } },
      { listHistory: (_aid, seqNrs) => seqNrs.filter((n) => n !== 1) },
      deleteSetup(1),
    );
    for (const seqNr of [1, 2, 3])
      unwrap(
        await store.persistEventAndSnapshot(
          eventOf("1", seqNr),
          snapshotOf(seqNr),
        ),
      );
    expect(await history(prefix)).toEqual([
      [1, true],
      [3, true],
    ]);
  });

  test("an aborted retention transaction is retried and selects again", async () => {
    let aborts = 1;
    const { prefix, store } = await plainStore(
      { retention: { count: 1 } },
      {
        beforeRetentionDelete: () => {
          if (aborts === 0) return;
          aborts -= 1;
          throw aborted();
        },
      },
      deleteSetup(1),
    );
    for (const seqNr of [1, 2])
      unwrap(
        await store.persistEventAndSnapshot(
          eventOf("1", seqNr),
          snapshotOf(seqNr),
        ),
      );
    expect(await history(prefix)).toEqual([[2, true]]);
  });
});
