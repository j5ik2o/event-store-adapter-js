import type { DatabaseSync } from "node:sqlite";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { verifySqliteLayout } from "./sqlite-layout";
import { endSqliteTransaction } from "./sqlite-transaction";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAYOUT_VERSION = BigInt(1);

type ConfigRow = Readonly<Record<string, unknown>>;

const invalid = (message: string) =>
  Result.err(EventStoreError.configuration("configuration", message));

/** 保存先に記録した config 行と、クライアントの設定を照合する純粋関数（SQ-2・SQ-19・SQ-20）。 */
export function reconcileSqliteStoreConfiguration(
  rows: readonly ConfigRow[],
  retentionCount: number | undefined,
): Result<Readonly<{ storeId: string }>, EventStoreError> {
  if (rows.length !== 1) return invalid("config must hold exactly one row");
  const row = rows[0];
  if (typeof row.store_id !== "string" || !UUID.test(row.store_id))
    return invalid("store_id must be a lower-case UUID");
  if (row.layout_version !== LAYOUT_VERSION)
    return invalid("layout_version must be 1");
  const expectedCount =
    retentionCount === undefined ? null : BigInt(retentionCount);
  if (row.keep_snapshot_count !== expectedCount)
    return invalid(
      "keep_snapshot_count does not match the retention count of the client",
    );
  if (row.retention_mode !== "delete")
    return invalid("retention_mode must be delete");
  if (row.change_feed_enabled !== BigInt(0))
    return invalid("this store requires a change feed, which is not supported");
  return Result.ok(Object.freeze({ storeId: row.store_id }));
}

/** 配置と config を、1 つの読み取りトランザクションの中で照合する。ファイルは変更しない。 */
export function verifySqliteStore(
  db: DatabaseSync,
  retentionCount: number | undefined,
): Result<Readonly<{ storeId: string }>, EventStoreError> {
  try {
    db.exec("BEGIN");
    try {
      const layout = verifySqliteLayout(db);
      if (layout.type === "err") return layout;
      const statement = db.prepare(
        "SELECT store_id, layout_version, keep_snapshot_count, retention_mode, change_feed_enabled FROM config",
      );
      statement.setReadBigInts(true);
      return reconcileSqliteStoreConfiguration(statement.all(), retentionCount);
    } finally {
      endSqliteTransaction(db);
    }
  } catch (cause) {
    return Result.err(
      EventStoreError.storage("SQLite store could not be verified", cause),
    );
  }
}
