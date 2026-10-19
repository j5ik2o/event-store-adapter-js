import type { Database } from "@google-cloud/spanner";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SpannerRetentionSettings } from "./spanner-event-store-input-validation";
import { spannerRows } from "./spanner-rows";
import { spannerStoredInteger } from "./spanner-stored-integer";
import type { SpannerTableNames } from "./spanner-table-names";

type LogicalTable = keyof SpannerTableNames;

type Column = Readonly<{ name: string; type: string }>;

export type SpannerObservedConfiguration = Readonly<{
  dialect: string | undefined;
  columns: Readonly<Record<LogicalTable, readonly Column[]>>;
  primaryKeys: Readonly<Record<LogicalTable, readonly string[]>>;
  /** snapshot_history の行削除ポリシーの式。なければ null。 */
  rowDeletionPolicy: string | null;
  /** config テーブルの行。行がなければ undefined。 */
  config: Readonly<Record<string, unknown>> | undefined;
}>;

const KEY: readonly Column[] = [
  { name: "hash_prefix", type: "BYTES(8)" },
  { name: "aid", type: "STRING(1024)" },
];
const SEQ: Column = { name: "seq_nr", type: "INT64" };
const MANIFEST: Column = { name: "manifest", type: "STRING(MAX)" };
const PAYLOAD: Column = { name: "payload", type: "BYTES(MAX)" };

const EXPECTED: Readonly<
  Record<
    LogicalTable,
    Readonly<{ columns: readonly Column[]; primaryKey: readonly string[] }>
  >
> = {
  journal: {
    columns: [
      ...KEY,
      SEQ,
      { name: "occurred_at_ns", type: "INT64" },
      MANIFEST,
      PAYLOAD,
    ],
    primaryKey: ["hash_prefix", "aid", "seq_nr"],
  },
  head: {
    columns: [
      ...KEY,
      { name: "type_name", type: "STRING(1024)" },
      SEQ,
      { name: "event_occurred_at_ns", type: "INT64" },
      { name: "event_manifest", type: "STRING(MAX)" },
      { name: "event_payload", type: "BYTES(MAX)" },
    ],
    primaryKey: ["hash_prefix", "aid"],
  },
  snapshotCurrent: {
    columns: [...KEY, SEQ, MANIFEST, PAYLOAD],
    primaryKey: ["hash_prefix", "aid"],
  },
  snapshotHistory: {
    columns: [
      ...KEY,
      SEQ,
      MANIFEST,
      PAYLOAD,
      { name: "expired_at", type: "TIMESTAMP" },
    ],
    primaryKey: ["hash_prefix", "aid", "seq_nr"],
  },
  config: {
    columns: [
      { name: "singleton", type: "INT64" },
      { name: "store_id", type: "STRING(36)" },
      { name: "layout_version", type: "INT64" },
      { name: "keep_snapshot_count", type: "INT64" },
      { name: "retention_mode", type: "STRING(8)" },
      { name: "ttl_grace_days", type: "INT64" },
      { name: "change_feed_enabled", type: "BOOL" },
    ],
    primaryKey: ["singleton"],
  },
};

const LOGICAL_TABLES = Object.keys(EXPECTED) as readonly LogicalTable[];
const GOOGLE_SQL = "GOOGLE_STANDARD_SQL";
const LAYOUT_VERSION = BigInt(1);
const MAX_INT64 = BigInt("9223372036854775807");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OLDER_THAN_DAYS =
  /^OLDER_THAN\(\s*expired_at\s*,\s*INTERVAL\s+(\d+)\s+DAY\s*\)$/i;

const invalid = (fieldName: string, message: string) =>
  Result.err(EventStoreError.configuration(fieldName, message));

function integerOrNull(
  raw: unknown,
  field: string,
): Result<bigint | null, EventStoreError> {
  if (raw === null || raw === undefined) return Result.ok(null);
  const value = spannerStoredInteger(raw, field, BigInt(1), MAX_INT64);
  return value.type === "ok"
    ? value
    : invalid("configuration", `${field} must be a positive INT64 or NULL`);
}

/** 観測した保存先と、クライアントの設定を照合する純粋関数（SPN-2・SPN-16・SPN-17）。 */
export function reconcileSpannerStoreConfiguration(
  observed: SpannerObservedConfiguration,
  settings: Readonly<{ retention: SpannerRetentionSettings | undefined }>,
): Result<Readonly<{ storeId: string }>, EventStoreError> {
  if (observed.dialect !== GOOGLE_SQL)
    return invalid("database", "database dialect must be GoogleSQL");
  for (const table of LOGICAL_TABLES) {
    const expected = EXPECTED[table];
    const actual = observed.columns[table];
    const missing = expected.columns.find(
      (column) =>
        !actual.some(
          (found) => found.name === column.name && found.type === column.type,
        ),
    );
    if (missing !== undefined)
      return invalid(
        "tablePrefix",
        `${table} must have column ${missing.name} ${missing.type}`,
      );
    const key = observed.primaryKeys[table];
    if (
      key.length !== expected.primaryKey.length ||
      key.some((name, index) => name !== expected.primaryKey[index])
    )
      return invalid("tablePrefix", `${table} primary key does not match`);
  }
  const config = observed.config;
  if (config === undefined)
    return invalid("tablePrefix", "config row is missing");
  const storeId = config.store_id;
  if (typeof storeId !== "string" || !UUID.test(storeId))
    return invalid("configuration", "store_id must be a lowercase UUID");
  const layout = spannerStoredInteger(
    config.layout_version,
    "layout_version",
    LAYOUT_VERSION,
    LAYOUT_VERSION,
  );
  if (layout.type === "err")
    return invalid("configuration", "layout_version must be 1");
  const keepCount = integerOrNull(
    config.keep_snapshot_count,
    "keep_snapshot_count",
  );
  if (keepCount.type === "err") return keepCount;
  const retention = settings.retention;
  const clientCount = retention === undefined ? null : BigInt(retention.count);
  if (keepCount.value !== clientCount)
    return invalid(
      "retention",
      "keep_snapshot_count does not match the retention count",
    );
  const recordedMode = config.retention_mode;
  const clientMode = retention?.mode.type ?? "delete";
  if (recordedMode !== "delete" && recordedMode !== "ttl")
    return invalid("configuration", "retention_mode must be delete or ttl");
  if (recordedMode !== clientMode)
    return invalid(
      "retention",
      "retention_mode does not match the retention mode",
    );
  const recordedGrace = integerOrNull(config.ttl_grace_days, "ttl_grace_days");
  if (recordedGrace.type === "err") return recordedGrace;
  if (config.change_feed_enabled !== false)
    return invalid(
      "configuration",
      "change_feed_enabled must be false (change feed is not supported)",
    );
  if (retention?.mode.type === "ttl") {
    const clientGrace = BigInt(retention.mode.graceDays);
    if (recordedGrace.value !== clientGrace)
      return invalid(
        "retention",
        "ttl_grace_days does not match the client graceDays",
      );
    const policy = OLDER_THAN_DAYS.exec(observed.rowDeletionPolicy ?? "");
    if (policy === null || BigInt(policy[1]) !== clientGrace)
      return invalid(
        "retention",
        "the row deletion policy days do not match the client graceDays",
      );
  } else {
    if (recordedGrace.value !== null)
      return invalid("configuration", "ttl_grace_days must be NULL for delete");
    if (observed.rowDeletionPolicy !== null)
      return invalid(
        "retention",
        "snapshot_history must not have a row deletion policy for delete",
      );
  }
  return Result.ok(Object.freeze({ storeId }));
}

/** 方言・列・主キー・行削除ポリシー・config を strong の読み取りで観測して照合する。DDL は実行しない。 */
export async function verifySpannerStoreConfiguration(
  settings: Readonly<{
    database: Database;
    tables: SpannerTableNames;
    retention: SpannerRetentionSettings | undefined;
  }>,
): Promise<Result<Readonly<{ storeId: string }>, EventStoreError>> {
  const { database, tables } = settings;
  try {
    const dialect = await database.getDatabaseDialect();
    const [snapshot] = await database.getSnapshot({ strong: true });
    try {
      const names = LOGICAL_TABLES.map((table) => tables[table]);
      const columnRows = await spannerRows(
        snapshot,
        "SELECT TABLE_NAME, COLUMN_NAME, SPANNER_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '' AND TABLE_NAME IN UNNEST(@tables) ORDER BY TABLE_NAME, ORDINAL_POSITION",
        { tables: names },
      );
      const keyRows = await spannerRows(
        snapshot,
        "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.INDEX_COLUMNS WHERE INDEX_NAME = 'PRIMARY_KEY' AND TABLE_SCHEMA = '' AND TABLE_NAME IN UNNEST(@tables) ORDER BY TABLE_NAME, ORDINAL_POSITION",
        { tables: names },
      );
      const policyRows = await spannerRows(
        snapshot,
        "SELECT ROW_DELETION_POLICY_EXPRESSION FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' AND TABLE_NAME = @table",
        { table: tables.snapshotHistory },
        { table: "string" },
      );
      const columns = Object.fromEntries(
        LOGICAL_TABLES.map((table) => [
          table,
          columnRows
            .filter((row) => row.TABLE_NAME === tables[table])
            .map((row) => ({
              name: String(row.COLUMN_NAME),
              type: String(row.SPANNER_TYPE),
            })),
        ]),
      ) as Record<LogicalTable, Column[]>;
      const primaryKeys = Object.fromEntries(
        LOGICAL_TABLES.map((table) => [
          table,
          keyRows
            .filter((row) => row.TABLE_NAME === tables[table])
            .map((row) => String(row.COLUMN_NAME)),
        ]),
      ) as Record<LogicalTable, string[]>;
      // config の列が欠けていれば読めないので、列の照合の結果として設定エラーにする。
      const configComplete = EXPECTED.config.columns.every((expected) =>
        columns.config.some(
          (found) =>
            found.name === expected.name && found.type === expected.type,
        ),
      );
      const configRows = !configComplete
        ? []
        : await spannerRows(
            snapshot,
            `SELECT store_id, layout_version, keep_snapshot_count, retention_mode, ttl_grace_days, change_feed_enabled FROM \`${tables.config}\` WHERE singleton = 1`,
          );
      const policy = policyRows[0]?.ROW_DELETION_POLICY_EXPRESSION;
      return reconcileSpannerStoreConfiguration(
        {
          dialect: dialect === undefined ? undefined : String(dialect),
          columns,
          primaryKeys,
          rowDeletionPolicy: typeof policy === "string" ? policy : null,
          config: configRows[0],
        },
        settings,
      );
    } finally {
      snapshot.end();
    }
  } catch (cause) {
    return Result.err(
      EventStoreError.storage("store configuration could not be read", cause),
    );
  }
}
