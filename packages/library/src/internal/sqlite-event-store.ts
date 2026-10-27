import { randomUUID } from "node:crypto";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SqliteEventStore } from "../sqlite-event-store";
import type { SqliteEventStoreInput } from "../sqlite-event-store-input";
import { openSqliteConnection } from "./sqlite-connection";
import type { SqliteConnectionState } from "./sqlite-connection-state";
import type { SqliteEventStoreHooks } from "./sqlite-event-store-hooks";
import { validateSqliteEventStoreInput } from "./sqlite-event-store-input-validation";
import { createSqliteGetEvents } from "./sqlite-get-events";
import { createSqliteGetLatestSnapshot } from "./sqlite-get-latest-snapshot";
import {
  createSqliteTables,
  isSqliteDatabaseUninitialized,
} from "./sqlite-layout";
import {
  createSqlitePersistEvent,
  createSqlitePersistEventAndSnapshot,
} from "./sqlite-persist-event";
import { verifySqliteStore } from "./sqlite-store-configuration";
import { endSqliteTransaction } from "./sqlite-transaction";

/**
 * 空のファイルに 5 つの表と config 行を、1 つの BEGIN IMMEDIATE の中で作る（SQ-D6）。
 * 既存のオブジェクトがあれば設定エラーにし、何も作らない。
 */
export async function initializeSqliteStoreInternal<PE = unknown, PS = unknown>(
  input: SqliteEventStoreInput<PE, PS>,
): Promise<Result<void, EventStoreError>> {
  const settings = validateSqliteEventStoreInput(input);
  if (settings.type === "err") return settings;
  const opened = openSqliteConnection(
    settings.value.path,
    settings.value.lockWaitMilliseconds,
    "create",
  );
  if (opened.type === "err") return opened;
  const db = opened.value;
  try {
    db.exec("BEGIN IMMEDIATE");
    if (!isSqliteDatabaseUninitialized(db)) {
      endSqliteTransaction(db);
      return Result.err(
        EventStoreError.configuration(
          "path",
          "the database file already holds objects and cannot be initialized",
        ),
      );
    }
    createSqliteTables(db);
    db.prepare(
      "INSERT INTO config (singleton, store_id, layout_version, keep_snapshot_count, retention_mode, change_feed_enabled) VALUES (1, ?, 1, ?, 'delete', 0)",
    ).run(
      randomUUID().toLowerCase(),
      settings.value.retentionCount === undefined
        ? null
        : BigInt(settings.value.retentionCount),
    );
    db.exec("COMMIT");
    return Result.ok(undefined);
  } catch (cause) {
    endSqliteTransaction(db);
    return Result.err(
      EventStoreError.storage("SQLite store could not be initialized", cause),
    );
  } finally {
    try {
      db.close();
    } catch {
      // 初期化の結果は確定済みか、すでに失敗として報告済み。閉鎖の失敗では結果を変えない。
    }
  }
}

/**
 * 照合後の 4 操作と close を返す内部入口。ファイルは初期化せず、表と行も変更しない。
 * ただし接続を開くときに journal_mode を WAL にするので、照合で拒否するファイルも WAL に切り替わる（SQ-1・SQ-14）。
 */
export async function openSqliteEventStoreInternal<PE = unknown, PS = unknown>(
  input: SqliteEventStoreInput<PE, PS>,
  hooks?: SqliteEventStoreHooks,
): Promise<Result<SqliteEventStore<PE, PS>, EventStoreError>> {
  const settings = validateSqliteEventStoreInput(input);
  if (settings.type === "err") return settings;
  const opened = openSqliteConnection(
    settings.value.path,
    settings.value.lockWaitMilliseconds,
    "existing",
  );
  if (opened.type === "err") return opened;
  const verified = verifySqliteStore(
    opened.value,
    settings.value.retentionCount,
  );
  if (verified.type === "err") {
    try {
      opened.value.close();
    } catch {
      // 照合の失敗を報告する。閉鎖の失敗では、その原因を隠さない。
    }
    return verified;
  }
  const connection: SqliteConnectionState = {
    db: opened.value,
    closed: false,
  };
  return Result.ok(
    Object.freeze({
      persistEvent: createSqlitePersistEvent(connection, settings.value, hooks),
      persistEventAndSnapshot: createSqlitePersistEventAndSnapshot(
        connection,
        settings.value,
        hooks,
      ),
      getLatestSnapshotById: createSqliteGetLatestSnapshot(
        connection,
        settings.value,
        hooks,
      ),
      getEventsByIdSinceSeqNr: createSqliteGetEvents(
        connection,
        settings.value,
        hooks,
      ),
      close(): Result<void, EventStoreError> {
        // closed の旗で二度目の close を防ぐ。node:sqlite は開いている接続の close で投げない。
        if (!connection.closed) {
          connection.db.close();
          connection.closed = true;
        }
        return Result.ok(undefined);
      },
    }),
  );
}
