import type { DatabaseSync } from "node:sqlite";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { declaredColumnCollation } from "./sqlite-column-collation";

/** seq_nr の列。範囲は 1 以上 2^53-1 以下（3 章）。Rust 版の配置と同じ。 */
const SEQ_NR =
  "seq_nr INTEGER NOT NULL CHECK (seq_nr BETWEEN 1 AND 9007199254740991)";

/** 5 つの表を STRICT として作る（SQ-16）。head_transition は作らない（SQ-20）。 */
export function createSqliteTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE journal (
       aid TEXT COLLATE BINARY NOT NULL,
       ${SEQ_NR},
       occurred_at_ns INTEGER NOT NULL,
       manifest TEXT NOT NULL,
       payload BLOB NOT NULL,
       PRIMARY KEY (aid, seq_nr)
     ) STRICT;
     CREATE TABLE head (
       aid TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
       type_name TEXT NOT NULL,
       ${SEQ_NR},
       event_occurred_at_ns INTEGER NOT NULL,
       event_manifest TEXT NOT NULL,
       event_payload BLOB NOT NULL
     ) STRICT;
     CREATE TABLE snapshot_current (
       aid TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
       ${SEQ_NR},
       manifest TEXT NOT NULL,
       payload BLOB NOT NULL
     ) STRICT;
     CREATE TABLE snapshot_history (
       aid TEXT COLLATE BINARY NOT NULL,
       ${SEQ_NR},
       manifest TEXT NOT NULL,
       payload BLOB NOT NULL,
       PRIMARY KEY (aid, seq_nr)
     ) STRICT;
     CREATE TABLE config (
       singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
       store_id TEXT NOT NULL,
       layout_version INTEGER NOT NULL,
       keep_snapshot_count INTEGER CHECK (keep_snapshot_count IS NULL OR keep_snapshot_count >= 1),
       retention_mode TEXT NOT NULL CHECK (retention_mode = 'delete'),
       change_feed_enabled INTEGER NOT NULL CHECK (change_feed_enabled IN (0, 1))
     ) STRICT;`);
}

/** アプリケーション用の表・索引・ビュー・トリガーが 1 つもない、未初期化のファイルなら真を返す（SQ-D6）。 */
export function isSqliteDatabaseUninitialized(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_schema WHERE lower(name) NOT GLOB 'sqlite_*'",
    )
    .get() as { n: number | bigint };
  return Number(row.n) === 0;
}

/** 列の期待: 名前・型・NOT NULL（0 か 1）・主キーの中の位置（主キーでなければ 0）。 */
type Column = readonly [string, string, number, number];

const EXPECTED_TABLES: readonly (readonly [string, readonly Column[]])[] = [
  [
    "journal",
    [
      ["aid", "TEXT", 1, 1],
      ["seq_nr", "INTEGER", 1, 2],
      ["occurred_at_ns", "INTEGER", 1, 0],
      ["manifest", "TEXT", 1, 0],
      ["payload", "BLOB", 1, 0],
    ],
  ],
  [
    "head",
    [
      ["aid", "TEXT", 1, 1],
      ["type_name", "TEXT", 1, 0],
      ["seq_nr", "INTEGER", 1, 0],
      ["event_occurred_at_ns", "INTEGER", 1, 0],
      ["event_manifest", "TEXT", 1, 0],
      ["event_payload", "BLOB", 1, 0],
    ],
  ],
  [
    "snapshot_current",
    [
      ["aid", "TEXT", 1, 1],
      ["seq_nr", "INTEGER", 1, 0],
      ["manifest", "TEXT", 1, 0],
      ["payload", "BLOB", 1, 0],
    ],
  ],
  [
    "snapshot_history",
    [
      ["aid", "TEXT", 1, 1],
      ["seq_nr", "INTEGER", 1, 2],
      ["manifest", "TEXT", 1, 0],
      ["payload", "BLOB", 1, 0],
    ],
  ],
  [
    "config",
    [
      ["singleton", "INTEGER", 1, 1],
      ["store_id", "TEXT", 1, 0],
      ["layout_version", "INTEGER", 1, 0],
      ["keep_snapshot_count", "INTEGER", 0, 0],
      ["retention_mode", "TEXT", 1, 0],
      ["change_feed_enabled", "INTEGER", 1, 0],
    ],
  ],
];

const isBinary = (name: unknown): boolean =>
  typeof name === "string" && name.toUpperCase() === "BINARY";

/** aid の照合順序が、列の宣言でも主キーの索引でも BINARY かを返す（SQ-2）。 */
function aidCollationsAreBinary(db: DatabaseSync, table: string): boolean {
  // 直前に pragma_table_list と pragma_table_info で表と列を確かめているので、表の SQL は必ずある。
  const schema = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string };
  if (!isBinary(declaredColumnCollation(schema.sql, "aid"))) return false;
  const keys = db
    .prepare(
      "SELECT x.coll AS coll FROM pragma_index_list(?1, 'main') AS l, pragma_index_xinfo(l.name, 'main') AS x WHERE l.origin = 'pk' AND x.key = 1 AND x.name = 'aid'",
    )
    .all(table) as { coll: unknown }[];
  return keys.length === 1 && keys.every((key) => isBinary(key.coll));
}

const mismatch = (message: string) =>
  Result.err(EventStoreError.configuration("database", message));

/**
 * 5 つの表が STRICT で、列の名前・型・NOT NULL・主キーの位置が期待どおりか、aid の照合順序が
 * BINARY かを、DDL の文字列ではなく pragma の意味で照合する（SQ-2・SQ-16）。
 * 欠けた定義は補わず、設定エラーにする。ファイルは変更しない。
 */
export function verifySqliteLayout(
  db: DatabaseSync,
): Result<void, EventStoreError> {
  for (const [table, expectedColumns] of EXPECTED_TABLES) {
    const listed = db
      .prepare(
        `SELECT "strict" AS strict FROM pragma_table_list WHERE schema = 'main' AND name = ?`,
      )
      .get(table) as { strict: number | bigint } | undefined;
    if (listed === undefined || Number(listed.strict) !== 1)
      return mismatch(`table ${table} is missing or is not STRICT`);
    const actual = db
      .prepare(
        `SELECT name, type, "notnull" AS not_null, pk FROM pragma_table_info(?) ORDER BY cid`,
      )
      .all(table) as {
      name: string;
      type: string;
      not_null: number | bigint;
      pk: number | bigint;
    }[];
    const matches =
      actual.length === expectedColumns.length &&
      actual.every((column, index) => {
        const [name, type, notNull, pk] = expectedColumns[index];
        return (
          column.name === name &&
          column.type === type &&
          Number(column.not_null) === notNull &&
          Number(column.pk) === pk
        );
      });
    if (!matches) return mismatch(`table ${table} does not match the layout`);
    if (
      expectedColumns.some(([name]) => name === "aid") &&
      !aidCollationsAreBinary(db, table)
    )
      return mismatch(`aid of ${table} must use the BINARY collation`);
  }
  return Result.ok(undefined);
}
