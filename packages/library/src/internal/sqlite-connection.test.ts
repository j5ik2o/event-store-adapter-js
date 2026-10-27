import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  meetsMinimumSqliteVersion,
  openSqliteConnection,
} from "./sqlite-connection";
import { sqliteErrorCode } from "./sqlite-error-code";
import { sqliteTempDirectory } from "./test/sqlite-fixture";

let temp = sqliteTempDirectory();
beforeEach(() => {
  temp = sqliteTempDirectory();
});
afterEach(() => {
  temp.remove();
});

const pragma = (db: DatabaseSync, name: string): unknown =>
  Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];

describe("meetsMinimumSqliteVersion", () => {
  test.each([
    ["3.51.3", true],
    ["3.51.4", true],
    ["3.52.0", true],
    ["3.100.0", true],
    ["4.0.0", true],
    ["3.51.2", false],
    ["3.9.9", false],
    ["3.50.99", false],
    ["2.99.99", false],
  ])("%s -> %p (compared part by part as integers)", (version, expected) => {
    expect(meetsMinimumSqliteVersion(version)).toBe(expected);
  });

  test.each(["", "abc", "3.51", "3.51.x"])(
    "rejects the malformed version %p",
    (version) => {
      expect(meetsMinimumSqliteVersion(version)).toBe(false);
    },
  );

  test("the bundled SQLite satisfies the minimum", () => {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("SELECT sqlite_version() AS v").get();
    db.close();
    expect(meetsMinimumSqliteVersion(String(row?.v))).toBe(true);
  });
});

describe("sqliteErrorCode", () => {
  test("reads the primary key violation (1555)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a TEXT PRIMARY KEY) STRICT");
    db.exec("INSERT INTO t VALUES ('x')");
    let caught: unknown;
    try {
      db.exec("INSERT INTO t VALUES ('x')");
    } catch (cause) {
      caught = cause;
    }
    db.close();
    expect(sqliteErrorCode(caught)).toBe(1555);
  });

  test("reads SQLITE_BUSY (5) raised by a real lock", () => {
    const file = temp.file();
    const holder = new DatabaseSync(file);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("CREATE TABLE t (a TEXT) STRICT");
    holder.exec("BEGIN IMMEDIATE");
    const other = new DatabaseSync(file);
    other.exec("PRAGMA busy_timeout = 0");
    let caught: unknown;
    try {
      other.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      caught = cause;
    }
    other.close();
    holder.exec("ROLLBACK");
    holder.close();
    expect(sqliteErrorCode(caught)).toBe(5);
  });

  test.each([
    ["a plain Error", new Error("x")],
    ["a string", "x"],
    ["undefined", undefined],
    ["null", null],
  ])("returns undefined for %s", (_, cause) => {
    expect(sqliteErrorCode(cause)).toBeUndefined();
  });
});

describe("openSqliteConnection", () => {
  test("create mode creates the file and verifies the connection pragmas (SQ-1, SQ-14, SQ-15)", () => {
    const file = temp.file();
    const opened = openSqliteConnection(file, 1234, "create");
    expect(opened.type).toBe("ok");
    if (opened.type !== "ok") return;
    const db = opened.value;
    try {
      expect(existsSync(file)).toBe(true);
      expect(pragma(db, "busy_timeout")).toBe(1234);
      expect(String(pragma(db, "journal_mode")).toLowerCase()).toBe("wal");
      expect(pragma(db, "synchronous")).toBe(2);
      expect(String(pragma(db, "locking_mode")).toLowerCase()).toBe("normal");
      expect(pragma(db, "read_uncommitted")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("existing mode never creates a missing file and reports a storage error", () => {
    const file = temp.file("missing.sqlite3");
    expect(openSqliteConnection(file, 5000, "existing")).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(existsSync(file)).toBe(false);
  });

  test("existing mode reopens a file created earlier", () => {
    const file = temp.file();
    const created = openSqliteConnection(file, 5000, "create");
    if (created.type === "ok") created.value.close();
    const reopened = openSqliteConnection(file, 100, "existing");
    expect(reopened.type).toBe("ok");
    if (reopened.type === "ok") {
      expect(pragma(reopened.value, "busy_timeout")).toBe(100);
      reopened.value.close();
    }
  });

  test("a directory path is a storage error, not a crash", () => {
    const directory = path.join(temp.directory, "dir");
    mkdirSync(directory);
    expect(openSqliteConnection(directory, 5000, "existing").type).toBe("err");
  });

  test("a path that looks like a URI is a literal file name", () => {
    const literal = path.join(
      temp.directory,
      "file:mem?mode=memory&cache=shared",
    );
    const opened = openSqliteConnection(literal, 5000, "create");
    expect(opened.type).toBe("ok");
    if (opened.type === "ok") opened.value.close();
    expect(existsSync(literal)).toBe(true);
  });

  test("the file named by a non-SQLite file content is rejected", () => {
    const file = temp.file("garbage.sqlite3");
    writeFileSync(file, "this is not a database file at all".repeat(10));
    const opened = openSqliteConnection(file, 5000, "existing");
    expect(opened.type).toBe("err");
  });
});
