import type { DatabaseSync } from "node:sqlite";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";

/**
 * ストアが所有する接続 1 本の状態。`closed` は `close` だけが変更する。
 * NOTE: 閉鎖の有無は接続の寿命そのものなので、ストアのハンドル内で可変にする。
 */
export type SqliteConnectionState = {
  readonly db: DatabaseSync;
  closed: boolean;
};

export function usableSqliteConnection(
  connection: SqliteConnectionState,
): Result<DatabaseSync, EventStoreError> {
  return connection.closed
    ? Result.err(EventStoreError.storage("SQLite store is closed"))
    : Result.ok(connection.db);
}
