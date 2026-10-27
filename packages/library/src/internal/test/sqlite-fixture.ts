import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 内部試験用。Rust 版 (lib/src/sqlite/layout.rs) が書くファイルと同じ DDL を逐語で持つ。
 * js の初期化を通さずに、Rust 形式・誤設定のファイルを実ファイルとして作る。
 */
export const SQLITE_STORE_ID = "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11";

const SEQ_NR =
  "seq_nr INTEGER NOT NULL CHECK (seq_nr BETWEEN 1 AND 9007199254740991)";

export type SqliteTableName =
  | "journal"
  | "head"
  | "snapshot_current"
  | "snapshot_history"
  | "config";

export const RUST_DDL: Readonly<Record<SqliteTableName, string>> = {
  journal: `CREATE TABLE journal (
       aid TEXT COLLATE BINARY NOT NULL,
       ${SEQ_NR},
       occurred_at_ns INTEGER NOT NULL,
       manifest TEXT NOT NULL,
       payload BLOB NOT NULL,
       PRIMARY KEY (aid, seq_nr)
     ) STRICT`,
  head: `CREATE TABLE head (
       aid TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
       type_name TEXT NOT NULL,
       ${SEQ_NR},
       event_occurred_at_ns INTEGER NOT NULL,
       event_manifest TEXT NOT NULL,
       event_payload BLOB NOT NULL
     ) STRICT`,
  snapshot_current: `CREATE TABLE snapshot_current (
       aid TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
       ${SEQ_NR},
       manifest TEXT NOT NULL,
       payload BLOB NOT NULL
     ) STRICT`,
  snapshot_history: `CREATE TABLE snapshot_history (
       aid TEXT COLLATE BINARY NOT NULL,
       ${SEQ_NR},
       manifest TEXT NOT NULL,
       payload BLOB NOT NULL,
       PRIMARY KEY (aid, seq_nr)
     ) STRICT`,
  config: `CREATE TABLE config (
       singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
       store_id TEXT NOT NULL,
       layout_version INTEGER NOT NULL,
       keep_snapshot_count INTEGER CHECK (keep_snapshot_count IS NULL OR keep_snapshot_count >= 1),
       retention_mode TEXT NOT NULL CHECK (retention_mode = 'delete'),
       change_feed_enabled INTEGER NOT NULL CHECK (change_feed_enabled IN (0, 1))
     ) STRICT`,
};

export type SqliteConfigRow = Readonly<{
  store_id: string;
  layout_version: number;
  keep_snapshot_count: number | null;
  retention_mode: string;
  change_feed_enabled: number;
}>;

export const defaultConfigRow: SqliteConfigRow = {
  store_id: SQLITE_STORE_ID,
  layout_version: 1,
  keep_snapshot_count: null,
  retention_mode: "delete",
  change_feed_enabled: 0,
};

export type SqliteFileSetup = Readonly<{
  /** 既定の DDL の代わりに使う表ごとの DDL。 */
  ddl?: Partial<Record<SqliteTableName, string>>;
  /** null なら config 行を入れない。 */
  config?: SqliteConfigRow | null;
  /** 作成直後に実行する追加の SQL（行の投入など）。 */
  extraSql?: string;
}>;

/** 空のディレクトリを作り、後始末を返す。 */
export function sqliteTempDirectory(): Readonly<{
  directory: string;
  file: (name?: string) => string;
  remove: () => void;
}> {
  const directory = mkdtempSync(path.join(tmpdir(), "esa-sqlite-"));
  mkdirSync(directory, { recursive: true });
  return Object.freeze({
    directory,
    file: (name = "store.sqlite3") => path.join(directory, name),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  });
}

/** Rust 版と同じ配置のファイルを作る。js の初期化は通さない。 */
export function writeSqliteFile(
  file: string,
  setup: SqliteFileSetup = {},
): void {
  const db = new DatabaseSync(file);
  try {
    const ddl = { ...RUST_DDL, ...setup.ddl };
    for (const table of Object.keys(RUST_DDL) as SqliteTableName[]) {
      db.exec(ddl[table]);
    }
    const config = setup.config === undefined ? defaultConfigRow : setup.config;
    if (config !== null) {
      db.prepare(
        "INSERT INTO config (singleton, store_id, layout_version, keep_snapshot_count, retention_mode, change_feed_enabled) VALUES (1, ?, ?, ?, ?, ?)",
      ).run(
        config.store_id,
        config.layout_version,
        config.keep_snapshot_count,
        config.retention_mode,
        config.change_feed_enabled,
      );
    }
    if (setup.extraSql !== undefined) db.exec(setup.extraSql);
  } finally {
    db.close();
  }
}

/** sqlite_schema と全表の行を文字列にして返す。検証がファイルを変えないことの比較に使う。 */
export function sqliteContentSnapshot(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = db
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name")
      .all();
    const rows = (Object.keys(RUST_DDL) as SqliteTableName[]).map((table) => {
      try {
        return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      } catch {
        // 表が無いファイルでは行を空として比べる。
        return [];
      }
    });
    return JSON.stringify([schema, rows], (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } finally {
    db.close();
  }
}

/** 内部試験用。テストで使う封筒の作り方を 1 か所にそろえる。 */
export const sqliteEventOf = (
  seqNr: number,
  id: Readonly<{ typeName: string; value: string }> = {
    typeName: "Order",
    value: "1",
  },
): Readonly<{
  aggregateId: { typeName: string; value: string };
  seqNr: number;
  occurredAt: Date;
  manifest: string;
  payload: { item: string; seqNr: number };
}> => ({
  aggregateId: { ...id },
  seqNr,
  occurredAt: new Date(Date.parse("2026-10-09T00:00:00.123Z") + seqNr),
  manifest: "event/v1",
  payload: { item: "book", seqNr },
});

export const sqliteSnapshotOf = (
  seqNr: number,
): Readonly<{
  seqNr: number;
  manifest: string;
  aggregate: { total: number };
}> => ({
  seqNr,
  manifest: "snapshot/v1",
  aggregate: { total: seqNr },
});

/** 実ファイルを別の接続で開いて読む。 */
export function readSqliteRows(
  file: string,
  sql: string,
  ...params: readonly (string | number | bigint)[]
): readonly Record<string, unknown>[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params);
  } finally {
    db.close();
  }
}

/** 実ファイルを別の接続で開いて変更する。 */
export function writeSqliteRows(file: string, sql: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
