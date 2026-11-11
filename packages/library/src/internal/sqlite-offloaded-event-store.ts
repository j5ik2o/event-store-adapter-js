import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SqliteBlockingExecution } from "../sqlite-blocking-execution";
import type { SqliteEventStore } from "../sqlite-event-store";
import type { SqliteEventStoreInput } from "../sqlite-event-store-input";
import { validateSeqNr } from "./seq-nr-validation";
import { sqliteWorkerLaneOf } from "./sqlite-blocking-execution";
import { validateSqliteEventStoreInput } from "./sqlite-event-store-input-validation";
import { restoreSqliteEvents } from "./sqlite-get-events";
import { restoreSqliteSnapshot } from "./sqlite-get-latest-snapshot";
import {
  prepareSqliteAppend,
  reportSqliteAppend,
  type SqliteAppend,
} from "./sqlite-persist-event";
import { restoreWireResult } from "./sqlite-worker-requests";
import {
  validateAggregateId,
  validateEvent,
  validateEventAndSnapshot,
} from "./validated-event-store";

/**
 * 小さな Buffer は共有のプールの一部で、postMessage はその裏の ArrayBuffer 全体（64 KiB）を写す。
 * ワーカーへ送る前に、ちょうどの大きさの Uint8Array に写す。
 */
const ownedPayloads = (append: SqliteAppend): SqliteAppend => ({
  ...append,
  rows: {
    ...append.rows,
    payload: new Uint8Array(append.rows.payload),
    snapshot:
      append.rows.snapshot === undefined
        ? undefined
        : {
            ...append.rows.snapshot,
            payload: new Uint8Array(append.rows.snapshot.payload),
          },
  },
});

const closedStore = () =>
  Result.err(EventStoreError.storage("SQLite store is closed"));

/**
 * `openSqliteEventStoreInternal` と同じ 4 操作と close を返す。SQL は execution のワーカーで実行し、
 * 検証、直列化と復元、保持の失敗の通知は、既存の入口と同じ関数を呼び出し元のスレッドで呼ぶ。
 */
export async function openOffloadedSqliteEventStoreInternal<
  PE = unknown,
  PS = unknown,
>(
  input: SqliteEventStoreInput<PE, PS>,
  execution: SqliteBlockingExecution,
): Promise<Result<SqliteEventStore<PE, PS>, EventStoreError>> {
  const settings = validateSqliteEventStoreInput(input);
  if (settings.type === "err") return settings;
  const lane = sqliteWorkerLaneOf(execution);
  if (lane.type === "err") return lane;
  const submit = lane.value.submit;
  const opened = await submit({
    kind: "open",
    path: settings.value.path,
    lockWaitMilliseconds: settings.value.lockWaitMilliseconds,
    retentionCount: settings.value.retentionCount,
  });
  if (opened.type === "err") return opened;
  const connection = restoreWireResult(opened.value);
  if (connection.type === "err") return connection;
  // NOTE: 閉鎖の有無はストアの寿命そのものなので、ハンドル内で可変にする。
  let closed = false;

  const append = async (
    prepared: ReturnType<typeof prepareSqliteAppend<PE, PS>>,
  ): Promise<Result<void, EventStoreError>> => {
    if (prepared.type === "err") return prepared;
    if (closed) return closedStore();
    const written = await submit({
      kind: "append",
      connection: connection.value,
      append: ownedPayloads(prepared.value),
    });
    if (written.type === "err") return written;
    return reportSqliteAppend(
      {
        appended: restoreWireResult(written.value.appended),
        retained:
          written.value.retained === undefined
            ? undefined
            : restoreWireResult(written.value.retained),
      },
      prepared.value.rows.aid,
      settings.value,
    );
  };

  return Result.ok(
    Object.freeze({
      async persistEvent(event) {
        const validated = validateEvent(event);
        if (validated.type === "err") return validated;
        return append(
          prepareSqliteAppend(settings.value, validated.value, undefined),
        );
      },
      async persistEventAndSnapshot(event, snapshot) {
        const validated = validateEventAndSnapshot(event, snapshot);
        if (validated.type === "err") return validated;
        return append(
          prepareSqliteAppend(
            settings.value,
            validated.value.event,
            validated.value.snapshot,
          ),
        );
      },
      async getLatestSnapshotById(aggregateId) {
        const validatedId = validateAggregateId(aggregateId);
        if (validatedId.type === "err") return validatedId;
        if (closed) return closedStore();
        const read = await submit({
          kind: "read-snapshot",
          connection: connection.value,
          aid: `${validatedId.value.typeName}-${validatedId.value.value}`,
        });
        if (read.type === "err") return read;
        const rows = restoreWireResult(read.value);
        if (rows.type === "err") return rows;
        return restoreSqliteSnapshot(
          rows.value,
          validatedId.value.typeName,
          settings.value.snapshotSerializer,
        );
      },
      async getEventsByIdSinceSeqNr(aggregateId, seqNr) {
        const validatedId = validateAggregateId(aggregateId);
        if (validatedId.type === "err") return validatedId;
        const start = validateSeqNr(seqNr);
        if (start.type === "err") return start;
        if (closed) return closedStore();
        const read = await submit({
          kind: "read-events",
          connection: connection.value,
          aid: `${validatedId.value.typeName}-${validatedId.value.value}`,
          start: start.value,
        });
        if (read.type === "err") return read;
        const rows = restoreWireResult(read.value);
        if (rows.type === "err") return rows;
        return restoreSqliteEvents(
          rows.value,
          validatedId.value,
          settings.value.eventSerializer,
        );
      },
      close(): Result<void, EventStoreError> {
        if (!closed) {
          closed = true;
          // 閉じる要求は満杯でも受け付ける。execution が閉じていて拒否されたときは、
          // ワーカーが終わるときにすべての接続を閉じるので、この結果は待たない。
          void submit({ kind: "close", connection: connection.value }, false);
        }
        return Result.ok(undefined);
      },
    } satisfies SqliteEventStore<PE, PS>),
  );
}
