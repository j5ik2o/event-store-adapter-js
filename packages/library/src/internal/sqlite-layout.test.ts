import { DatabaseSync } from "node:sqlite";
import { SqliteEventStore } from "../sqlite-event-store";
import {
  createSqliteTables,
  isSqliteDatabaseUninitialized,
  verifySqliteLayout,
} from "./sqlite-layout";
import {
  RUST_DDL,
  type SqliteTableName,
  sqliteContentSnapshot,
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

const withDb = <T>(fn: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(temp.file());
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

describe("createSqliteTables / isSqliteDatabaseUninitialized", () => {
  test("an empty file is uninitialized and a created layout is not", () => {
    withDb((db) => {
      expect(isSqliteDatabaseUninitialized(db)).toBe(true);
      createSqliteTables(db);
      expect(isSqliteDatabaseUninitialized(db)).toBe(false);
    });
  });

  test("creates exactly the five STRICT tables and no head_transition (SQ-16, SQ-20)", () => {
    withDb((db) => {
      createSqliteTables(db);
      const tables = db
        .prepare(
          `SELECT name, "strict" AS strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all()
        .map((r) => [r.name, Number(r.strict)]);
      expect(tables).toEqual([
        ["config", 1],
        ["head", 1],
        ["journal", 1],
        ["snapshot_current", 1],
        ["snapshot_history", 1],
      ]);
    });
  });

  test("a file holding only an unrelated index or view is not uninitialized", () => {
    withDb((db) => {
      db.exec("CREATE VIEW v AS SELECT 1 AS x");
      expect(isSqliteDatabaseUninitialized(db)).toBe(false);
    });
  });

  test("the layout created by js passes verification", () => {
    withDb((db) => {
      createSqliteTables(db);
      expect(verifySqliteLayout(db).type).toBe("ok");
    });
  });
});

describe("verifySqliteLayout on Rust-format files", () => {
  test("accepts the Rust DDL verbatim", () => {
    writeSqliteFile(temp.file());
    withDb((db) => expect(verifySqliteLayout(db).type).toBe("ok"));
  });

  test.each([
    [
      "a missing table",
      (t: SqliteTableName) =>
        t === "head" ? "CREATE TABLE unused (x INTEGER) STRICT" : RUST_DDL[t],
    ],
    [
      "a non-STRICT table",
      (t: SqliteTableName) =>
        t === "journal"
          ? RUST_DDL.journal.replace(/\) STRICT$/, ")")
          : RUST_DDL[t],
    ],
    [
      "a changed column type",
      (t: SqliteTableName) =>
        t === "snapshot_current"
          ? RUST_DDL.snapshot_current.replace("manifest TEXT", "manifest BLOB")
          : RUST_DDL[t],
    ],
    [
      "a nullable column",
      (t: SqliteTableName) =>
        t === "snapshot_history"
          ? RUST_DDL.snapshot_history.replace(
              "manifest TEXT NOT NULL",
              "manifest TEXT",
            )
          : RUST_DDL[t],
    ],
    [
      "a changed primary key",
      (t: SqliteTableName) =>
        t === "journal"
          ? RUST_DDL.journal.replace(
              "PRIMARY KEY (aid, seq_nr)",
              "PRIMARY KEY (seq_nr, aid)",
            )
          : RUST_DDL[t],
    ],
    [
      "an extra column",
      (t: SqliteTableName) =>
        t === "config"
          ? RUST_DDL.config.replace(
              "singleton INTEGER",
              "extra TEXT, singleton INTEGER",
            )
          : RUST_DDL[t],
    ],
  ])("rejects %s as a configuration error", (_, ddlOf) => {
    const ddl = Object.fromEntries(
      (Object.keys(RUST_DDL) as SqliteTableName[]).map((t) => [t, ddlOf(t)]),
    );
    writeSqliteFile(temp.file(), { ddl });
    withDb((db) =>
      expect(verifySqliteLayout(db)).toMatchObject({
        type: "err",
        error: { type: "configuration-error" },
      }),
    );
  });
});

describe("aid collation (SQ-2)", () => {
  const journalWith = (aidColumn: string, key: string): string =>
    RUST_DDL.journal
      .replace("aid TEXT COLLATE BINARY NOT NULL", aidColumn)
      .replace("PRIMARY KEY (aid, seq_nr)", `PRIMARY KEY (${key}, seq_nr)`);

  const openFile = () => SqliteEventStore.create({ path: temp.file() });

  test("accepts an aid without any COLLATE clause (BINARY by default)", async () => {
    writeSqliteFile(temp.file(), {
      ddl: { journal: journalWith("aid TEXT NOT NULL", "aid") },
    });
    const store = await openFile();
    expect(store.type).toBe("ok");
    if (store.type === "ok") expect(store.value.close().type).toBe("ok");
  });

  test("accepts a quoted column name with an explicit lowercase binary", async () => {
    writeSqliteFile(temp.file(), {
      ddl: {
        head: RUST_DDL.head.replace(
          "aid TEXT COLLATE BINARY NOT NULL PRIMARY KEY",
          '"aid" TEXT COLLATE binary NOT NULL PRIMARY KEY',
        ),
      },
    });
    const store = await openFile();
    expect(store.type).toBe("ok");
    if (store.type === "ok") store.value.close();
  });

  test("rejects a NOCASE column with a BINARY primary key index, and leaves the file untouched", async () => {
    writeSqliteFile(temp.file(), {
      ddl: {
        journal: journalWith(
          "aid TEXT COLLATE NOCASE NOT NULL",
          "aid COLLATE BINARY",
        ),
      },
      extraSql:
        "INSERT INTO journal (aid, seq_nr, occurred_at_ns, manifest, payload) VALUES ('User-A', 1, 0, '', x'7b7d')",
    });
    const before = sqliteContentSnapshot(temp.file());
    expect(await openFile()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(sqliteContentSnapshot(temp.file())).toBe(before);
  });

  test("rejects an RTRIM column", async () => {
    writeSqliteFile(temp.file(), {
      ddl: {
        snapshot_current: RUST_DDL.snapshot_current.replace(
          "COLLATE BINARY",
          "COLLATE RTRIM",
        ),
      },
    });
    expect(await openFile()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("rejects a BINARY column whose primary key index is NOCASE", async () => {
    writeSqliteFile(temp.file(), {
      ddl: {
        journal: journalWith(
          "aid TEXT COLLATE BINARY NOT NULL",
          "aid COLLATE NOCASE",
        ),
      },
    });
    expect(await openFile()).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("does not count COLLATE inside CHECK, DEFAULT, or comments as the column collation", async () => {
    writeSqliteFile(temp.file(), {
      ddl: {
        journal: journalWith(
          "aid TEXT NOT NULL CHECK (aid COLLATE NOCASE = aid) DEFAULT 'COLLATE NOCASE' /* COLLATE NOCASE */ -- COLLATE RTRIM\n",
          "aid",
        ),
      },
    });
    const store = await openFile();
    expect(store.type).toBe("ok");
    if (store.type === "ok") store.value.close();
  });
});
