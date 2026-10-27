import { DatabaseSync } from "node:sqlite";
import { SqliteEventStore } from "../sqlite-event-store";
import {
  RUST_DDL,
  readSqliteRows,
  type SqliteTableName,
  sqliteEventOf,
  sqliteSnapshotOf,
  sqliteTempDirectory,
  writeSqliteFile,
} from "./test/sqlite-fixture";

let temp = sqliteTempDirectory();
beforeEach(() => {
  temp = sqliteTempDirectory();
});
afterEach(() => {
  temp.remove();
});

const utf8 = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
const TABLES = Object.keys(RUST_DDL) as SqliteTableName[];

// Rust 版 (lib/src/sqlite) が書く値の形: aid は "{type}-{value}"、時刻はナノ秒の整数、payload は BLOB。
function seedRustRows(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const journal = db.prepare(
      "INSERT INTO journal (aid, seq_nr, occurred_at_ns, manifest, payload) VALUES (?, ?, ?, ?, ?)",
    );
    journal.run(
      "Order-1",
      BigInt(1),
      BigInt("1791504000123456789"),
      "event/v1",
      utf8({ item: "book", seqNr: 1 }),
    );
    journal.run(
      "Order-1",
      BigInt(2),
      BigInt("1791504001000000000"),
      "event/v1",
      utf8({ item: "pen", seqNr: 2 }),
    );
    db.prepare(
      "INSERT INTO head (aid, type_name, seq_nr, event_occurred_at_ns, event_manifest, event_payload) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "Order-1",
      "Order",
      BigInt(2),
      BigInt("1791504001000000000"),
      "event/v1",
      utf8({ item: "pen", seqNr: 2 }),
    );
    for (const table of ["snapshot_current", "snapshot_history"]) {
      db.prepare(
        `INSERT INTO ${table} (aid, seq_nr, manifest, payload) VALUES (?, ?, ?, ?)`,
      ).run("Order-1", BigInt(1), "snapshot/v1", utf8({ total: 1 }));
    }
  } finally {
    db.close();
  }
}

describe("a file written in the Rust format (acceptance 4)", () => {
  test("js reads the events and the snapshot that the Rust DDL and value shapes hold", async () => {
    writeSqliteFile(temp.file(), {
      config: {
        store_id: "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11",
        layout_version: 1,
        keep_snapshot_count: 2,
        retention_mode: "delete",
        change_feed_enabled: 0,
      },
    });
    seedRustRows(temp.file());
    const created = await SqliteEventStore.create({
      path: temp.file(),
      retention: { count: 2 },
    });
    if (created.type === "err") throw new Error(created.error.message);
    const store = created.value;
    try {
      const id = { typeName: "Order", value: "1" };
      const events = await store.getEventsByIdSinceSeqNr(id, 1);
      expect(events).toMatchObject({ type: "ok" });
      if (events.type !== "ok") return;
      expect(events.value.map((e) => [e.seqNr, e.manifest, e.payload])).toEqual(
        [
          [1, "event/v1", { item: "book", seqNr: 1 }],
          [2, "event/v1", { item: "pen", seqNr: 2 }],
        ],
      );
      expect(events.value[0]?.occurredAt.getTime()).toBe(1_791_504_000_123);
      expect(await store.getLatestSnapshotById(id)).toMatchObject({
        type: "ok",
        value: {
          headSeqNr: 2,
          snapshot: {
            seqNr: 1,
            manifest: "snapshot/v1",
            aggregate: { total: 1 },
          },
        },
      });
    } finally {
      store.close();
    }
  });

  test("js appends to a Rust-written file, and the new rows have the Rust shape", async () => {
    writeSqliteFile(temp.file(), {
      config: {
        store_id: "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11",
        layout_version: 1,
        keep_snapshot_count: 2,
        retention_mode: "delete",
        change_feed_enabled: 0,
      },
    });
    seedRustRows(temp.file());
    const created = await SqliteEventStore.create({
      path: temp.file(),
      retention: { count: 2 },
    });
    if (created.type === "err") throw new Error(created.error.message);
    const store = created.value;
    try {
      const appended = await store.persistEventAndSnapshot(
        sqliteEventOf(3),
        sqliteSnapshotOf(3),
      );
      expect(appended.type).toBe("ok");
    } finally {
      store.close();
    }
    expect(
      readSqliteRows(
        temp.file(),
        "SELECT aid, seq_nr, occurred_at_ns, manifest, hex(payload) AS payload FROM journal WHERE seq_nr = 3",
      )[0],
    ).toEqual({
      aid: "Order-1",
      seq_nr: BigInt(3),
      occurred_at_ns:
        BigInt(sqliteEventOf(3).occurredAt.getTime()) * BigInt(1000000),
      manifest: "event/v1",
      payload: Buffer.from(utf8(sqliteEventOf(3).payload))
        .toString("hex")
        .toUpperCase(),
    });
    expect(
      readSqliteRows(
        temp.file(),
        "SELECT aid, type_name, seq_nr, event_manifest FROM head",
      )[0],
    ).toEqual({
      aid: "Order-1",
      type_name: "Order",
      seq_nr: BigInt(3),
      event_manifest: "event/v1",
    });
    expect(
      readSqliteRows(
        temp.file(),
        "SELECT seq_nr FROM snapshot_history ORDER BY seq_nr",
      ).map((r) => r.seq_nr),
    ).toEqual([BigInt(1), BigInt(3)]);
  });
});

describe("the layout js initializes equals the Rust layout", () => {
  const describeLayout = (file: string): unknown =>
    TABLES.map((table) => ({
      table,
      list: readSqliteRows(
        file,
        `SELECT name, "strict" AS strict, ncol FROM pragma_table_list WHERE schema = 'main' AND name = ?`,
        table,
      ),
      columns: readSqliteRows(
        file,
        'SELECT cid, name, type, "notnull" AS not_null, pk FROM pragma_table_info(?) ORDER BY cid',
        table,
      ),
      keys: readSqliteRows(
        file,
        "SELECT x.seqno, x.name, x.coll FROM pragma_index_list(?) l, pragma_index_xinfo(l.name) x WHERE l.origin = 'pk' AND x.key = 1 ORDER BY x.seqno",
        table,
      ),
    }));

  test("tables, STRICT flags, columns, primary keys and key collations match", async () => {
    const rust = temp.file("rust.sqlite3");
    writeSqliteFile(rust);
    const js = temp.file("js.sqlite3");
    const initialized = await SqliteEventStore.initialize({ path: js });
    expect(initialized.type).toBe("ok");
    expect(describeLayout(js)).toEqual(describeLayout(rust));
    const objects = (file: string) =>
      readSqliteRows(
        file,
        "SELECT type, name FROM sqlite_schema ORDER BY type, name",
      );
    expect(objects(js)).toEqual(objects(rust));
  });

  test("a file js initialized opens again with the same options", async () => {
    const js = temp.file("again.sqlite3");
    expect(
      (await SqliteEventStore.initialize({ path: js, retention: { count: 3 } }))
        .type,
    ).toBe("ok");
    const created = await SqliteEventStore.create({
      path: js,
      retention: { count: 3 },
    });
    expect(created.type).toBe("ok");
    if (created.type === "ok") created.value.close();
  });
});
