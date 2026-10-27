import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { SqliteEventStore } from "../sqlite-event-store";
import {
  defaultConfigRow,
  RUST_DDL,
  readSqliteRows,
  SQLITE_STORE_ID,
  type SqliteConfigRow,
  sqliteContentSnapshot,
  sqliteTempDirectory,
  writeSqliteFile,
} from "./test/sqlite-fixture";

let temp: ReturnType<typeof sqliteTempDirectory>;
beforeEach(() => {
  temp = sqliteTempDirectory();
});
afterEach(() => {
  temp.remove();
});

const open = (retention?: { count: number }) =>
  SqliteEventStore.create({
    path: temp.file(),
    ...(retention === undefined ? {} : { retention }),
  });

const row = (overrides: Partial<SqliteConfigRow>): SqliteConfigRow => ({
  ...defaultConfigRow,
  ...overrides,
});

// retention_mode の CHECK を外した配置。記録された値が違うファイルを作るために使う。
const configWithoutModeCheck = RUST_DDL.config.replace(
  "CHECK (retention_mode = 'delete')",
  "",
);

describe("recorded configuration against the client (SQ-2, SQ-19)", () => {
  test.each([
    ["no retention on both sides", row({}), undefined],
    [
      "the same keep count on both sides",
      row({ keep_snapshot_count: 2 }),
      { count: 2 },
    ],
  ])("accepts %s", async (_, seeded, retention) => {
    writeSqliteFile(temp.file(), { config: seeded });
    const created = await open(retention);
    expect(created.type).toBe("ok");
    if (created.type === "ok") created.value.close();
  });

  test.each([
    [
      "the client count 1 differs from the recorded 2",
      row({ keep_snapshot_count: 2 }),
      { count: 1 },
    ],
    ["the client has a count but none is recorded", row({}), { count: 1 }],
    [
      "a count is recorded but the client has none",
      row({ keep_snapshot_count: 2 }),
      undefined,
    ],
    ["layout_version 2", row({ layout_version: 2 }), undefined],
    ["layout_version 0", row({ layout_version: 0 }), undefined],
    ["change_feed_enabled 1", row({ change_feed_enabled: 1 }), undefined],
    [
      "an upper-case store_id",
      row({ store_id: SQLITE_STORE_ID.toUpperCase() }),
      undefined,
    ],
    ["a malformed store_id", row({ store_id: "NOT-A-UUID" }), undefined],
    ["an empty store_id", row({ store_id: "" }), undefined],
  ])("rejects %s with a configuration error", async (_, seeded, retention) => {
    writeSqliteFile(temp.file(), { config: seeded });
    const before = sqliteContentSnapshot(temp.file());
    expect(await open(retention)).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(sqliteContentSnapshot(temp.file())).toBe(before);
  });

  test("rejects a retention_mode other than delete", async () => {
    writeSqliteFile(temp.file(), {
      ddl: { config: configWithoutModeCheck },
      config: row({ retention_mode: "ttl" }),
    });
    expect(await open()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("rejects a file with no config row and does not add one", async () => {
    writeSqliteFile(temp.file(), { config: null });
    const before = sqliteContentSnapshot(temp.file());
    expect(await open()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(sqliteContentSnapshot(temp.file())).toBe(before);
  });
});

describe("layout problems found on open (SQ-OPEN, SQ-16)", () => {
  test("a non-STRICT table is a configuration error", async () => {
    writeSqliteFile(temp.file(), {
      ddl: { head: RUST_DDL.head.replace(/\) STRICT$/, ")") },
    });
    expect(await open()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("a missing table is a configuration error and is not recreated", async () => {
    writeSqliteFile(temp.file(), { extraSql: "DROP TABLE snapshot_history" });
    const before = sqliteContentSnapshot(temp.file());
    expect(await open()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(sqliteContentSnapshot(temp.file())).toBe(before);
  });

  test("an empty existing file is a configuration error and stays empty", async () => {
    writeFileSync(temp.file(), "");
    expect(await open()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("a file that is not a SQLite database is an error and is left alone", async () => {
    writeFileSync(temp.file(), "this is not a database file at all".repeat(20));
    const created = await open();
    expect(created.type).toBe("err");
  });
});

describe("opening a rejected file (SQ-1, SQ-14, SQ-2)", () => {
  const journalMode = (): unknown =>
    readSqliteRows(temp.file(), "PRAGMA journal_mode")[0]?.journal_mode;

  test("a rejected file keeps its tables and rows, but opening switches journal_mode from delete to wal", async () => {
    writeSqliteFile(temp.file(), {
      config: row({ keep_snapshot_count: 3 }),
    });
    const before = sqliteContentSnapshot(temp.file());
    expect(journalMode()).toBe("delete");
    expect(await open({ count: 5 })).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(sqliteContentSnapshot(temp.file())).toBe(before);
    expect(journalMode()).toBe("wal");
  });

  test("a file whose config table pages are damaged is a storage error, not a configuration error", () => {
    writeSqliteFile(temp.file());
    const [{ rootpage }] = readSqliteRows(
      temp.file(),
      "SELECT rootpage FROM sqlite_schema WHERE name = 'config'",
    ) as [{ rootpage: bigint }];
    const [{ page_size: pageSize }] = readSqliteRows(
      temp.file(),
      "PRAGMA page_size",
    ) as [{ page_size: bigint }];
    const fd = openSync(temp.file(), "r+");
    try {
      const size = Number(pageSize);
      writeSync(
        fd,
        Buffer.alloc(size, 0xff),
        0,
        size,
        (Number(rootpage) - 1) * size,
      );
    } finally {
      closeSync(fd);
    }
    return expect(open()).resolves.toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });
});
