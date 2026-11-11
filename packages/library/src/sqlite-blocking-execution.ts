import type { EventStoreError } from "./event-store-error";
import {
  createSqliteBlockingExecution,
  startSqliteWorker,
} from "./internal/sqlite-blocking-execution";
import type { Result } from "./result";

/**
 * SQLite の操作を、受け付けた順に 1 つの worker_threads のワーカーで実行する実行資源。利用者が作って所有する。
 * 終えるときは、ストアを閉じてから `close` を呼び、`drained` を待つ。
 */
export type SqliteBlockingExecution = Readonly<{
  /** 新しい操作の受け付けを止める。何度呼んでもよい。受け付け済みの操作は止めない。 */
  close(): void;
  /** `close` のあと、受け付け済みの操作が終わり、ワーカーが接続を閉じて終了したら解決する。 */
  drained(): Promise<void>;
}>;

export namespace SqliteBlockingExecution {
  /**
   * ワーカー 1 つと、実行中の 1 件のほかに `queueCapacity` 件を待たせる待ち行列を持つ実行資源を作る。
   * `queueCapacity` が正の整数でなければ設定エラー、ワーカーを起動できなければ保存先エラーにする。
   */
  export function singleWorker(
    queueCapacity: number,
  ): Result<SqliteBlockingExecution, EventStoreError> {
    return createSqliteBlockingExecution(queueCapacity, startSqliteWorker);
  }
}

Object.freeze(SqliteBlockingExecution);
