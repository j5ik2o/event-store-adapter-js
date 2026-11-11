import type { DatabaseSync } from "node:sqlite";
import type { MessagePort } from "node:worker_threads";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { readSqliteEventRows, type SqliteEventRows } from "./sqlite-get-events";
import {
  readSqliteSnapshotRows,
  type SqliteSnapshotRows,
} from "./sqlite-get-latest-snapshot";
import {
  type SqliteAppend,
  type SqliteAppendOutcome,
  writeSqliteAppend,
} from "./sqlite-persist-event";
import { openVerifiedSqliteConnection } from "./sqlite-store-configuration";

/** ワーカーが受ける要求。値はスレッドを越えて複製できるものだけにする。 */
export type SqliteWorkerRequest =
  | Readonly<{
      kind: "open";
      path: string;
      lockWaitMilliseconds: number;
      retentionCount: number | undefined;
    }>
  | Readonly<{ kind: "append"; connection: number; append: SqliteAppend }>
  | Readonly<{
      kind: "read-events";
      connection: number;
      aid: string;
      start: number;
    }>
  | Readonly<{ kind: "read-snapshot"; connection: number; aid: string }>
  | Readonly<{ kind: "close"; connection: number }>;

type SqliteWorkerResponses = {
  open: Result<number, EventStoreError>;
  append: SqliteAppendOutcome;
  "read-events": Result<SqliteEventRows, EventStoreError>;
  "read-snapshot": Result<SqliteSnapshotRows, EventStoreError>;
  close: Result<void, EventStoreError>;
};

export type SqliteWorkerResponse<K extends SqliteWorkerRequest["kind"]> =
  SqliteWorkerResponses[K];

/** 受け付けた要求をすべて終えたあとに、すべての接続を閉じてワーカーを終える合図。 */
export const SQLITE_WORKER_SHUTDOWN = "shutdown";

/**
 * ワーカーの中で、届いた順に要求を 1 件ずつ実行して答える。1 件は await を挟まずに終える（SQ-5）。
 * 接続はこの中だけが持つ。
 */
export function serveSqliteWorkerRequests(port: MessagePort): void {
  const connections = new Map<number, DatabaseSync>();
  let opened = 0;
  const usable = (
    connection: number,
  ): Result<DatabaseSync, EventStoreError> => {
    const db = connections.get(connection);
    return db === undefined
      ? Result.err(EventStoreError.storage("SQLite store is closed"))
      : Result.ok(db);
  };
  const handle = (
    request: SqliteWorkerRequest,
  ): SqliteWorkerResponse<SqliteWorkerRequest["kind"]> => {
    switch (request.kind) {
      case "open": {
        const db = openVerifiedSqliteConnection(
          request.path,
          request.lockWaitMilliseconds,
          request.retentionCount,
        );
        if (db.type === "err") return wireResult<number>(db);
        opened += 1;
        connections.set(opened, db.value);
        return wireResult(Result.ok(opened));
      }
      case "append": {
        const db = usable(request.connection);
        if (db.type === "err") return { appended: db, retained: undefined };
        const outcome = writeSqliteAppend(db.value, request.append);
        return {
          appended: wireResult(outcome.appended),
          retained:
            outcome.retained === undefined
              ? undefined
              : wireResult(outcome.retained),
        };
      }
      case "read-events": {
        const db = usable(request.connection);
        if (db.type === "err") return db;
        return wireResult(
          readSqliteEventRows(db.value, request.aid, request.start),
        );
      }
      case "read-snapshot": {
        const db = usable(request.connection);
        if (db.type === "err") return db;
        return wireResult(readSqliteSnapshotRows(db.value, request.aid));
      }
      case "close": {
        // node:sqlite は開いている接続の close で投げない。二度目は一覧に無いので閉じない。
        connections.get(request.connection)?.close();
        connections.delete(request.connection);
        return wireResult(Result.ok(undefined));
      }
    }
  };
  port.on("message", (message: SqliteWorkerRequest | "shutdown") => {
    if (message === SQLITE_WORKER_SHUTDOWN) {
      for (const db of connections.values()) db.close();
      connections.clear();
      port.close();
      return;
    }
    port.postMessage(handle(message));
  });
}

/**
 * スレッドを越えると、Error の message・stack・name は残るが、node:sqlite が足す errcode などの欄は落ちる。
 * その欄を写して送り、`restoreWireResult` で元に戻す。
 */
type WireError = EventStoreError &
  Readonly<{ causeProperties?: Readonly<Record<string, unknown>> }>;

function wireResult<T>(
  result: Result<T, EventStoreError>,
): Result<T, EventStoreError> {
  if (result.type === "ok" || !Error.isError(result.error.cause)) return result;
  const error: WireError = {
    ...result.error,
    causeProperties: { ...result.error.cause },
  };
  return { type: "err", error };
}

/** ワーカーから届いた結果を、既存の入口が返すものと同じ凍結した形に戻す。 */
export function restoreWireResult<T>(
  wire: Result<T, EventStoreError>,
): Result<T, EventStoreError> {
  if (wire.type === "ok") return Result.ok(wire.value);
  const { causeProperties, ...error } = wire.error as WireError;
  if (causeProperties !== undefined)
    Object.assign(error.cause as Error, causeProperties);
  return Result.err(Object.freeze(error) as EventStoreError);
}
