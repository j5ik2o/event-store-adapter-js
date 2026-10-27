import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventStore } from "../sqlite-event-store";
import type { SqliteEventStoreInput } from "../sqlite-event-store-input";
import { sqliteErrorCode } from "./sqlite-error-code";
import {
  initializeSqliteStoreInternal,
  openSqliteEventStoreInternal,
} from "./sqlite-event-store";
import type { SqliteEventStoreHooks } from "./sqlite-event-store-hooks";
import {
  readSqliteRows,
  sqliteContentSnapshot,
  sqliteEventOf,
  sqliteSnapshotOf,
  sqliteTempDirectory,
  writeSqliteRows,
} from "./test/sqlite-fixture";

let temp: ReturnType<typeof sqliteTempDirectory>;
const opened: SqliteEventStore[] = [];
beforeEach(() => {
  temp = sqliteTempDirectory();
});
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  temp.remove();
});

function input(extra: Partial<SqliteEventStoreInput<unknown, unknown>> = {}) {
  return { path: temp.file(), ...extra } as SqliteEventStoreInput<
    unknown,
    unknown
  >;
}

async function newStore(
  extra: Partial<SqliteEventStoreInput<unknown, unknown>> = {},
  hooks?: SqliteEventStoreHooks,
): Promise<SqliteEventStore> {
  const initialized = await SqliteEventStore.initialize(input(extra));
  if (initialized.type === "err") throw new Error(initialized.error.message);
  return openStore(extra, hooks);
}

async function openStore(
  extra: Partial<SqliteEventStoreInput<unknown, unknown>> = {},
  hooks?: SqliteEventStoreHooks,
): Promise<SqliteEventStore> {
  const created = await openSqliteEventStoreInternal(input(extra), hooks);
  if (created.type === "err") throw new Error(created.error.message);
  opened.push(created.value);
  return created.value;
}

const ok = <T>(
  r: { type: "ok"; value: T } | { type: "err"; error: unknown },
) => {
  if (r.type === "err") throw new Error(JSON.stringify(r.error));
  return r.value;
};
const idOf = (typeName: string, value: string) => ({ typeName, value });
const file = () => temp.file();

describe("initialize and create (SQ-INIT, SQ-OPEN)", () => {
  test("initialize builds the five tables and the config row, and no head_transition", async () => {
    ok(await SqliteEventStore.initialize(input({ retention: { count: 3 } })));
    const tables = readSqliteRows(
      file(),
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).map((r) => r.name);
    expect(tables).toEqual([
      "config",
      "head",
      "journal",
      "snapshot_current",
      "snapshot_history",
    ]);
    const [config, ...rest] = readSqliteRows(
      file(),
      "SELECT singleton, store_id, layout_version, keep_snapshot_count, retention_mode, change_feed_enabled FROM config",
    );
    expect(rest).toEqual([]);
    expect(config).toMatchObject({
      singleton: BigInt(1),
      layout_version: BigInt(1),
      keep_snapshot_count: BigInt(3),
      retention_mode: "delete",
      change_feed_enabled: BigInt(0),
    });
    expect(String(config?.store_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("initialize records NULL when no retention is configured", async () => {
    ok(await SqliteEventStore.initialize(input()));
    expect(
      readSqliteRows(file(), "SELECT keep_snapshot_count AS k FROM config")[0]
        ?.k,
    ).toBeNull();
  });

  test("a second initialize is a configuration error and changes nothing", async () => {
    ok(await SqliteEventStore.initialize(input()));
    const before = sqliteContentSnapshot(file());
    expect(await SqliteEventStore.initialize(input())).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(sqliteContentSnapshot(file())).toBe(before);
  });

  test("initialize refuses a file that already holds an unrelated object and creates nothing", async () => {
    writeSqliteRows(file(), "CREATE TABLE unrelated (x INTEGER)");
    expect(await SqliteEventStore.initialize(input())).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(
      readSqliteRows(file(), "SELECT name FROM sqlite_schema").map(
        (r) => r.name,
      ),
    ).toEqual(["unrelated"]);
  });

  test("create never initializes: an empty existing file is a configuration error and stays empty", async () => {
    writeFileSync(file(), "");
    const created = await SqliteEventStore.create(input());
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM sqlite_schema")[0]?.n,
    ).toBe(BigInt(0));
  });

  test("create on a missing file is a storage error and does not create the file", async () => {
    expect(await SqliteEventStore.create(input())).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(existsSync(file())).toBe(false);
  });

  test.each([
    [
      "ttl retention",
      { retention: { count: 1, mode: { type: "ttl", graceSeconds: 60 } } },
    ],
    ["changeFeed", { changeFeed: true }],
  ])(
    "%s is a configuration error for initialize and create, before the file is opened (SQ-11, SQ-20)",
    async (_, extra) => {
      const bad = input(extra as never);
      expect(await SqliteEventStore.initialize(bad)).toMatchObject({
        type: "err",
        error: { type: "configuration-error" },
      });
      expect(existsSync(file())).toBe(false);
      expect(await SqliteEventStore.create(bad)).toMatchObject({
        type: "err",
        error: { type: "configuration-error" },
      });
      expect(existsSync(file())).toBe(false);
    },
  );

  test("create on an initialized file rejects ttl and changeFeed settings", async () => {
    ok(await SqliteEventStore.initialize(input()));
    for (const extra of [
      { retention: { count: 1, mode: { type: "ttl", graceSeconds: 60 } } },
      { changeFeed: {} },
    ]) {
      expect(
        await SqliteEventStore.create(input(extra as never)),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error" },
      });
    }
  });

  test("opening a valid file does not modify its schema or rows", async () => {
    await newStore();
    for (const earlier of opened.splice(0)) earlier.close();
    const before = sqliteContentSnapshot(file());
    const store = ok(await SqliteEventStore.create(input()));
    store.close();
    expect(sqliteContentSnapshot(file())).toBe(before);
  });

  test("SQ-INIT: initialize followed by create does not need any other call", async () => {
    ok(await SqliteEventStore.initialize(input()));
    const store = ok(await SqliteEventStore.create(input()));
    expect(store.close().type).toBe("ok");
    expect((await initializeSqliteStoreInternal(input())).type).toBe("err");
  });
});

describe("lifecycle (SQ-LIFECYCLE)", () => {
  test("create, write, close, reopen and read", async () => {
    const store = await newStore();
    ok(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    );
    ok(await store.persistEvent(sqliteEventOf(2)));
    expect(store.close().type).toBe("ok");
    const reopened = ok(await SqliteEventStore.create(input()));
    opened.push(reopened);
    const latest = ok(await reopened.getLatestSnapshotById(idOf("Order", "1")));
    expect(latest).toMatchObject({
      headSeqNr: 2,
      snapshot: { seqNr: 1, manifest: "snapshot/v1", aggregate: { total: 1 } },
    });
    const events = ok(
      await reopened.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    );
    expect(events.map((e) => e.seqNr)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({
      manifest: "event/v1",
      payload: { item: "book", seqNr: 2 },
    });
    expect(events[1]?.occurredAt.getTime()).toBe(
      sqliteEventOf(2).occurredAt.getTime(),
    );
  });

  test("close can be called repeatedly and every later operation is a storage error", async () => {
    const store = await newStore();
    expect(store.close().type).toBe("ok");
    expect(store.close().type).toBe("ok");
    const id = idOf("Order", "1");
    const results = [
      await store.persistEvent(sqliteEventOf(1)),
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
      await store.getLatestSnapshotById(id),
      await store.getEventsByIdSinceSeqNr(id, 1),
    ];
    for (const result of results) {
      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
    }
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM journal")[0]?.n,
    ).toBe(BigInt(0));
  });

  test("two stores on one file share the records", async () => {
    const a = await newStore();
    const b = await openStore();
    ok(await a.persistEvent(sqliteEventOf(1)));
    expect(
      ok(await b.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1)),
    ).toHaveLength(1);
  });

  test("the head is not cached: a store numbers its next append from what another store committed", async () => {
    const a = await newStore();
    const b = await openStore();
    ok(await a.persistEvent(sqliteEventOf(1)));
    ok(await b.persistEvent(sqliteEventOf(2)));
    expect(await a.persistEvent(sqliteEventOf(2))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", seqNr: 2, headSeqNr: 2 },
    });
    ok(await a.persistEvent(sqliteEventOf(3)));
    expect(ok(await b.getLatestSnapshotById(idOf("Order", "1")))).toMatchObject(
      { headSeqNr: 3 },
    );
  });
});

describe("append (SQ-APPEND)", () => {
  test("a first event with a snapshot fills journal, head, snapshot_current and snapshot_history", async () => {
    const store = await newStore({ retention: { count: 2 } });
    ok(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    );
    const count = (table: string) =>
      readSqliteRows(file(), `SELECT count(*) AS n FROM ${table}`)[0]?.n;
    expect(count("journal")).toBe(BigInt(1));
    expect(count("head")).toBe(BigInt(1));
    expect(count("snapshot_current")).toBe(BigInt(1));
    expect(count("snapshot_history")).toBe(BigInt(1));
    expect(
      readSqliteRows(file(), "SELECT aid, type_name, seq_nr FROM head")[0],
    ).toMatchObject({ aid: "Order-1", type_name: "Order", seq_nr: BigInt(1) });
  });

  test("an event without a snapshot leaves the snapshot tables untouched", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    ok(await store.persistEvent(sqliteEventOf(2)));
    for (const table of ["snapshot_current", "snapshot_history"]) {
      expect(
        readSqliteRows(file(), `SELECT count(*) AS n FROM ${table}`)[0]?.n,
      ).toBe(BigInt(0));
    }
    expect(readSqliteRows(file(), "SELECT seq_nr FROM head")[0]?.seq_nr).toBe(
      BigInt(2),
    );
  });

  test("a duplicate seqNr is an optimistic lock conflict with the head", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    ok(await store.persistEvent(sqliteEventOf(2)));
    expect(await store.persistEvent(sqliteEventOf(2))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", seqNr: 2, headSeqNr: 2 },
    });
    expect(await store.persistEvent(sqliteEventOf(1))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", seqNr: 1, headSeqNr: 2 },
    });
  });

  test("a gap is the W-8 contract violation and commits nothing", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    expect(await store.persistEvent(sqliteEventOf(3))).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-8" },
    });
    expect(await store.persistEvent(sqliteEventOf(2))).toMatchObject({
      type: "ok",
    });
  });

  test("a first event must be seqNr 1 (W-8)", async () => {
    const store = await newStore();
    expect(await store.persistEvent(sqliteEventOf(2))).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-8" },
    });
  });

  test("a snapshot whose seqNr differs from the event is W-9 and commits nothing", async () => {
    const store = await newStore();
    expect(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(2),
      ),
    ).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-9" },
    });
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM journal")[0]?.n,
    ).toBe(BigInt(0));
    expect(readSqliteRows(file(), "SELECT count(*) AS n FROM head")[0]?.n).toBe(
      BigInt(0),
    );
  });

  test("the head is read after BEGIN IMMEDIATE has taken the write lock (SQ-5, SQ-17)", async () => {
    let probe: number | undefined | "no-error";
    const store = await newStore(
      {},
      {
        afterHeadRead: () => {
          const other = new DatabaseSync(file());
          try {
            other.exec("PRAGMA busy_timeout = 0");
            other.exec("BEGIN IMMEDIATE");
            probe = "no-error";
            other.exec("ROLLBACK");
          } catch (cause) {
            probe = sqliteErrorCode(cause);
          } finally {
            other.close();
          }
        },
      },
    );
    ok(await store.persistEvent(sqliteEventOf(1)));
    expect(probe).toBe(5);
  });

  test("a failure after the journal and head rows were written rolls everything back (SQ-6)", async () => {
    const store = await newStore();
    writeSqliteRows(
      file(),
      "ALTER TABLE snapshot_current RENAME TO snapshot_current_moved",
    );
    const result = await store.persistEventAndSnapshot(
      sqliteEventOf(1),
      sqliteSnapshotOf(1),
    );
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM journal")[0]?.n,
    ).toBe(BigInt(0));
    expect(readSqliteRows(file(), "SELECT count(*) AS n FROM head")[0]?.n).toBe(
      BigInt(0),
    );
    writeSqliteRows(
      file(),
      "ALTER TABLE snapshot_current_moved RENAME TO snapshot_current",
    );
  });

  test("a failure just before COMMIT is a storage error, publishes nothing, and the same seqNr can be written again (SQ-6)", async () => {
    let fail = true;
    const store = await newStore(
      {},
      {
        beforeCommit: () => {
          if (fail) throw new Error("injected before commit");
        },
      },
    );
    expect(await store.persistEvent(sqliteEventOf(1))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM journal")[0]?.n,
    ).toBe(BigInt(0));
    expect(readSqliteRows(file(), "SELECT count(*) AS n FROM head")[0]?.n).toBe(
      BigInt(0),
    );
    fail = false;
    ok(await store.persistEvent(sqliteEventOf(1)));
  });

  test("a payload serializer failure is a serialization error and commits nothing", async () => {
    const store = await newStore({
      eventSerializer: {
        serialize: () => {
          throw new Error("boom");
        },
        deserialize: () => ({}),
      },
    });
    expect(await store.persistEvent(sqliteEventOf(1))).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "serialize" },
    });
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM journal")[0]?.n,
    ).toBe(BigInt(0));
  });
});

describe("read (SQ-READ)", () => {
  test("no head means no snapshot answer and no events", async () => {
    const store = await newStore();
    expect(
      ok(await store.getLatestSnapshotById(idOf("Order", "9"))),
    ).toBeUndefined();
    expect(
      ok(await store.getEventsByIdSinceSeqNr(idOf("Order", "9"), 1)),
    ).toEqual([]);
  });

  test("a head without a snapshot returns the head seqNr and no snapshot", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    const latest = ok(await store.getLatestSnapshotById(idOf("Order", "1")));
    expect(latest?.headSeqNr).toBe(1);
    expect(latest?.snapshot).toBeUndefined();
  });

  test("events are filtered by start seqNr, sorted, and a start of 0 is treated as 1", async () => {
    const store = await newStore();
    for (const seq of [1, 2, 3, 4])
      ok(await store.persistEvent(sqliteEventOf(seq)));
    const id = idOf("Order", "1");
    expect(
      ok(await store.getEventsByIdSinceSeqNr(id, 3)).map((e) => e.seqNr),
    ).toEqual([3, 4]);
    expect(
      ok(await store.getEventsByIdSinceSeqNr(id, 0)).map((e) => e.seqNr),
    ).toEqual([1, 2, 3, 4]);
    expect(ok(await store.getEventsByIdSinceSeqNr(id, 5))).toEqual([]);
  });

  test("a journal row missing below the head is a storage error", async () => {
    const store = await newStore();
    for (const seq of [1, 2, 3])
      ok(await store.persistEvent(sqliteEventOf(seq)));
    writeSqliteRows(file(), "DELETE FROM journal WHERE seq_nr = 2");
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });

  test("a snapshot_current row ahead of the head is a storage error (R-8)", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(
      file(),
      "INSERT INTO snapshot_current (aid, seq_nr, manifest, payload) VALUES ('Order-1', 5, 's', x'7b7d')",
    );
    expect(await store.getLatestSnapshotById(idOf("Order", "1"))).toMatchObject(
      {
        type: "err",
        error: { type: "storage-error" },
      },
    );
  });

  test("a payload that the serializer cannot decode is a deserialization error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(file(), "UPDATE journal SET payload = x'ff00ff'");
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "deserialize" },
    });
  });

  test("events are read from one read transaction: a commit between the head read and the journal read is not mixed in (SQ-8, SQ-9)", async () => {
    let interleave: (() => void) | undefined;
    const reader = await newStore({}, { afterReadHead: () => interleave?.() });
    ok(await reader.persistEvent(sqliteEventOf(1)));
    interleave = () => {
      // 同期フックの中で別の接続が確定する。読み取りは head を読んだ時点の組を返す。
      const db = new DatabaseSync(file());
      try {
        db.exec("PRAGMA busy_timeout = 1000");
        db.exec("BEGIN IMMEDIATE");
        db.exec(
          "INSERT INTO journal (aid, seq_nr, occurred_at_ns, manifest, payload) VALUES ('Order-1', 2, 0, 'e', x'7b7d')",
        );
        db.exec("UPDATE head SET seq_nr = 2 WHERE aid = 'Order-1'");
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      interleave = undefined;
    };
    const events = ok(
      await reader.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    );
    expect(events.map((e) => e.seqNr)).toEqual([1]);
    // 次の読み取りでは確定済みの 2 が見える。
    expect(
      ok(await reader.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1)).map(
        (e) => e.seqNr,
      ),
    ).toEqual([1, 2]);
  });

  test("the latest snapshot is read from one read transaction (SQ-8)", async () => {
    let interleave: (() => void) | undefined;
    const reader = await newStore({}, { afterReadHead: () => interleave?.() });
    ok(
      await reader.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    );
    interleave = () => {
      const db = new DatabaseSync(file());
      try {
        db.exec("PRAGMA busy_timeout = 1000");
        db.exec("BEGIN IMMEDIATE");
        db.exec("UPDATE head SET seq_nr = 2 WHERE aid = 'Order-1'");
        db.exec("UPDATE snapshot_current SET seq_nr = 2 WHERE aid = 'Order-1'");
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      interleave = undefined;
    };
    const latest = ok(await reader.getLatestSnapshotById(idOf("Order", "1")));
    expect(latest?.headSeqNr).toBe(1);
    expect(latest?.snapshot?.seqNr).toBe(1);
  });
});

describe("stored values (SQ-VALUES)", () => {
  test("integers are stored as integers, text as text, payloads as blobs", async () => {
    const store = await newStore();
    ok(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    );
    expect(
      readSqliteRows(
        file(),
        "SELECT typeof(aid) a, typeof(seq_nr) s, typeof(occurred_at_ns) o, typeof(manifest) m, typeof(payload) p FROM journal",
      )[0],
    ).toEqual({ a: "text", s: "integer", o: "integer", m: "text", p: "blob" });
    expect(
      readSqliteRows(
        file(),
        "SELECT typeof(seq_nr) s, typeof(manifest) m, typeof(payload) p FROM snapshot_current",
      )[0],
    ).toEqual({ s: "integer", m: "text", p: "blob" });
    expect(
      readSqliteRows(
        file(),
        "SELECT typeof(event_occurred_at_ns) o, typeof(event_payload) p FROM head",
      )[0],
    ).toEqual({ o: "integer", p: "blob" });
  });

  test("occurred_at_ns is the millisecond time times 1,000,000, exactly", async () => {
    const store = await newStore();
    const event = sqliteEventOf(1);
    ok(await store.persistEvent(event));
    expect(
      readSqliteRows(file(), "SELECT occurred_at_ns AS n FROM journal")[0]?.n,
    ).toBe(BigInt(event.occurredAt.getTime()) * BigInt(1000000));
  });

  test.each([
    [BigInt(-1), -1],
    [BigInt(-1000000), -1],
    [BigInt(-1000001), -2],
    [BigInt(0), 0],
    [BigInt(999999), 0],
    [BigInt(1999999), 1],
    [BigInt("1791504000123456789"), 1_791_504_000_123],
  ])(
    "reads %p ns as %p ms, rounding toward negative infinity",
    async (ns, ms) => {
      const store = await newStore();
      ok(await store.persistEvent(sqliteEventOf(1)));
      const db = new DatabaseSync(file());
      db.prepare("UPDATE journal SET occurred_at_ns = ?").run(ns);
      db.close();
      const [event] = ok(
        await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
      );
      expect(event?.occurredAt.getTime()).toBe(ms);
    },
  );

  test("aggregate ids are compared exactly: case, LIKE wildcards and prefixes do not collide", async () => {
    const store = await newStore();
    const ids = [
      idOf("User", "A"),
      idOf("User", "a"),
      idOf("Order", "%"),
      idOf("Order", "1"),
      idOf("Order", "10"),
    ];
    for (const id of ids) ok(await store.persistEvent(sqliteEventOf(1, id)));
    for (const id of ids) {
      ok(await store.persistEvent(sqliteEventOf(2, id)));
      const events = ok(await store.getEventsByIdSinceSeqNr(id, 1));
      expect(events.map((e) => e.seqNr)).toEqual([1, 2]);
      expect(
        events.every(
          (e) =>
            e.aggregateId.value === id.value &&
            e.aggregateId.typeName === id.typeName,
        ),
      ).toBe(true);
    }
    expect(
      readSqliteRows(file(), "SELECT aid FROM head ORDER BY aid").map(
        (r) => r.aid,
      ),
    ).toEqual(["Order-%", "Order-1", "Order-10", "User-A", "User-a"]);
  });
});

// 開いた後に別の接続が表を型のない表へ差し替え、保存された値が壊れている状況を実ファイルで作る。
function replaceTableAfterOpen(
  table: string,
  columns: string,
  values: string,
): void {
  writeSqliteRows(
    file(),
    `ALTER TABLE ${table} RENAME TO ${table}_moved; CREATE TABLE ${table} (${columns}); INSERT INTO ${table} VALUES ${values}`,
  );
}

const withoutChecks = (sql: string): string =>
  `PRAGMA ignore_check_constraints = ON; ${sql}`;

describe("argument and stored value guards (read and append)", () => {
  test("getEventsByIdSinceSeqNr rejects an aggregate id whose typeName contains '-' as a contract violation", async () => {
    const store = await newStore();
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("A-B", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "contract-violation" } });
  });

  test("getEventsByIdSinceSeqNr rejects a start number that is not a safe integer", async () => {
    const store = await newStore();
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), -1),
    ).toMatchObject({ type: "err", error: { type: "contract-violation" } });
  });

  test("getLatestSnapshotById rejects an aggregate id whose typeName contains '-'", async () => {
    const store = await newStore();
    expect(await store.getLatestSnapshotById(idOf("A-B", "1"))).toMatchObject({
      type: "err",
      error: { type: "contract-violation" },
    });
  });

  test("a head number 0 on disk is a storage error when reading events", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(file(), withoutChecks("UPDATE head SET seq_nr = 0"));
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  });

  test("a head number 0 on disk is a storage error when reading the latest snapshot", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(file(), withoutChecks("UPDATE head SET seq_nr = 0"));
    expect(await store.getLatestSnapshotById(idOf("Order", "1"))).toMatchObject(
      { type: "err", error: { type: "storage-error" } },
    );
  });

  test("a head whose type_name differs from the requested typeName is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(file(), "UPDATE head SET type_name = 'Other'");
    expect(await store.getLatestSnapshotById(idOf("Order", "1"))).toMatchObject(
      { type: "err", error: { type: "storage-error" } },
    );
  });

  test("a journal row with a text seq_nr is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    replaceTableAfterOpen(
      "journal",
      "aid, seq_nr, occurred_at_ns, manifest, payload",
      "('Order-1', 'one', 0, 'event/v1', x'7b7d')",
    );
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  });

  test("a journal row whose seq_nr is stored as a real number is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    replaceTableAfterOpen(
      "journal",
      "aid, seq_nr, occurred_at_ns, manifest, payload",
      "('Order-1', 1.0, 0, 'event/v1', x'7b7d')",
    );
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  });

  test("a journal row with a text occurred_at_ns is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    replaceTableAfterOpen(
      "journal",
      "aid, seq_nr, occurred_at_ns, manifest, payload",
      "('Order-1', 1, 'noon', 'event/v1', x'7b7d')",
    );
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  });

  test("a journal row whose manifest is not text is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    replaceTableAfterOpen(
      "journal",
      "aid, seq_nr, occurred_at_ns, manifest, payload",
      "('Order-1', 1, 0, 42, x'7b7d')",
    );
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  });

  test("a snapshot_current row with a text seq_nr is a storage error", async () => {
    const store = await newStore();
    ok(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    );
    replaceTableAfterOpen(
      "snapshot_current",
      "aid, seq_nr, manifest, payload",
      "('Order-1', 'one', 'snapshot/v1', x'7b7d')",
    );
    expect(await store.getLatestSnapshotById(idOf("Order", "1"))).toMatchObject(
      { type: "err", error: { type: "storage-error" } },
    );
  });

  test("a snapshot_current row whose manifest is not text is a storage error", async () => {
    const store = await newStore();
    ok(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    );
    replaceTableAfterOpen(
      "snapshot_current",
      "aid, seq_nr, manifest, payload",
      "('Order-1', 1, 42, x'7b7d')",
    );
    expect(await store.getLatestSnapshotById(idOf("Order", "1"))).toMatchObject(
      { type: "err", error: { type: "storage-error" } },
    );
  });

  test("a head number 0 on disk fails the append as a storage error and publishes nothing", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(file(), withoutChecks("UPDATE head SET seq_nr = 0"));
    expect(await store.persistEvent(sqliteEventOf(2))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM journal")[0]?.n,
    ).toBe(BigInt(1));
  });

  test("a journal row ahead of the head makes the primary key collide and is an optimistic lock conflict", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(
      file(),
      "INSERT INTO journal (aid, seq_nr, occurred_at_ns, manifest, payload) VALUES ('Order-1', 2, 0, 'event/v1', x'7b7d')",
    );
    expect(await store.persistEvent(sqliteEventOf(2))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict" },
    });
    expect(readSqliteRows(file(), "SELECT seq_nr FROM head")[0]?.seq_nr).toBe(
      BigInt(1),
    );
  });

  test("a trigger that aborts the journal insert is a storage error and nothing is committed", async () => {
    const store = await newStore();
    writeSqliteRows(
      file(),
      "CREATE TRIGGER refuse BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(await store.persistEvent(sqliteEventOf(1))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(readSqliteRows(file(), "SELECT count(*) AS n FROM head")[0]?.n).toBe(
      BigInt(0),
    );
  });

  test("a serializer that returns something other than a Uint8Array is a serialization error and writes nothing", async () => {
    const store = await newStore({
      eventSerializer: {
        serialize: () => "not bytes" as unknown as Uint8Array,
        deserialize: () => ({}),
      },
    });
    expect(await store.persistEvent(sqliteEventOf(1))).toMatchObject({
      type: "err",
      error: { type: "serialization-error" },
    });
    expect(readSqliteRows(file(), "SELECT count(*) AS n FROM head")[0]?.n).toBe(
      BigInt(0),
    );
  });
});

describe("storage failures while reading and appending", () => {
  test("a renamed journal table while reading events is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(file(), "ALTER TABLE journal RENAME TO journal_moved");
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  });

  test("a journal that lost a row below the head is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    ok(await store.persistEvent(sqliteEventOf(2)));
    ok(await store.persistEvent(sqliteEventOf(3)));
    writeSqliteRows(file(), "DELETE FROM journal WHERE seq_nr = 2");
    expect(
      await store.getEventsByIdSinceSeqNr(idOf("Order", "1"), 1),
    ).toMatchObject({ type: "err", error: { type: "storage-error" } });
  });

  test("a renamed head table while reading the latest snapshot is a storage error", async () => {
    const store = await newStore();
    ok(await store.persistEvent(sqliteEventOf(1)));
    writeSqliteRows(file(), "ALTER TABLE head RENAME TO head_moved");
    expect(await store.getLatestSnapshotById(idOf("Order", "1"))).toMatchObject(
      { type: "err", error: { type: "storage-error" } },
    );
  });

  test("a snapshot serializer that throws on read is a serialization error", async () => {
    const store = await newStore({
      snapshotSerializer: {
        serialize: () => new Uint8Array([123, 125]),
        deserialize: () => {
          throw new Error("cannot restore");
        },
      },
    });
    ok(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    );
    expect(await store.getLatestSnapshotById(idOf("Order", "1"))).toMatchObject(
      { type: "err", error: { type: "serialization-error" } },
    );
  });

  test("a snapshot serializer that returns something other than a Uint8Array is a serialization error and writes nothing", async () => {
    const store = await newStore({
      snapshotSerializer: {
        serialize: () => "not bytes" as unknown as Uint8Array,
        deserialize: () => ({}),
      },
    });
    expect(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    ).toMatchObject({ type: "err", error: { type: "serialization-error" } });
    expect(readSqliteRows(file(), "SELECT count(*) AS n FROM head")[0]?.n).toBe(
      BigInt(0),
    );
  });

  test("an event with an invalid sequence number is a contract violation and writes nothing", async () => {
    const store = await newStore();
    expect(await store.persistEvent(sqliteEventOf(0))).toMatchObject({
      type: "err",
      error: { type: "contract-violation" },
    });
    expect(readSqliteRows(file(), "SELECT count(*) AS n FROM head")[0]?.n).toBe(
      BigInt(0),
    );
  });
});

describe("initialize and close failures", () => {
  test("initialize on a path whose parent directory does not exist is a storage error", async () => {
    const missing = `${temp.directory}/no-such-directory/store.sqlite3`;
    expect(await SqliteEventStore.initialize({ path: missing })).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(existsSync(missing)).toBe(false);
  });

  test("create on a path whose parent directory does not exist is a storage error", async () => {
    const missing = `${temp.directory}/no-such-directory/store.sqlite3`;
    expect(await SqliteEventStore.create({ path: missing })).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });

  test("initialize that cannot take the write lock is a storage error and leaves the file empty", async () => {
    const holder = new DatabaseSync(file());
    try {
      // 先に WAL にしておく。そうしないと失敗が接続を開く段階の journal_mode の切り替えで起こる。
      holder.exec("PRAGMA journal_mode = WAL");
      holder.exec("BEGIN IMMEDIATE");
      expect(
        await SqliteEventStore.initialize(input({ lockWaitMilliseconds: 0 })),
      ).toMatchObject({ type: "err", error: { type: "storage-error" } });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(
      readSqliteRows(file(), "SELECT count(*) AS n FROM sqlite_schema")[0]?.n,
    ).toBe(BigInt(0));
  });

  test("close is idempotent and every operation after it is a storage error", async () => {
    const store = await newStore();
    expect(store.close().type).toBe("ok");
    expect(store.close().type).toBe("ok");
    expect(await store.persistEvent(sqliteEventOf(1))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });
});
