import type { EventStore } from "./event-store";
import type { EventStoreError } from "./event-store-error";
import {
  initializeSqliteStoreInternal,
  openSqliteEventStoreInternal,
} from "./internal/sqlite-event-store";
import { openOffloadedSqliteEventStoreInternal } from "./internal/sqlite-offloaded-event-store";
import type { Result } from "./result";
import type { SqliteBlockingExecution } from "./sqlite-blocking-execution";
import type { SqliteEventStoreInput } from "./sqlite-event-store-input";

/** 4 操作に加えて、所有する接続を閉じる `close` を持つ。 */
export type SqliteEventStore<PE = unknown, PS = unknown> = EventStore<PE, PS> &
  Readonly<{ close(): Result<void, EventStoreError> }>;

export namespace SqliteEventStore {
  /** 空のファイルに 5 つの表と config 行を作る（SQ-D6）。開く操作は初期化しない。 */
  export async function initialize<PE = unknown, PS = unknown>(
    input: SqliteEventStoreInput<PE, PS>,
  ): Promise<Result<void, EventStoreError>> {
    return initializeSqliteStoreInternal(input);
  }

  /**
   * 初期化済みのファイルを照合して開く。接続はこのストアが所有し、`close` で閉じる。
   * node:sqlite は同期 API なので、操作の I/O（書き込みロックの待ちを含む）のあいだ、イベントループが止まる。
   */
  export async function create<PE = unknown, PS = unknown>(
    input: SqliteEventStoreInput<PE, PS>,
  ): Promise<Result<SqliteEventStore<PE, PS>, EventStoreError>> {
    return openSqliteEventStoreInternal(input);
  }

  /**
   * `create` と同じストアを、接続と SQL の実行を `execution` のワーカーに置いて開く。I/O のあいだもイベントループは止まらない。
   * 直列化と復元、ロガー、`onRetentionFailure` は呼び出し元のスレッドで呼ぶ。
   * 満杯か閉じた `execution` に出した操作は、実行せずに保存先エラーになる。Promise を待つのをやめても、受け付けた操作は止まらず、確定し得る。
   * `close` は以後の操作を保存先エラーにし、受け付け済みの操作のあとで接続を閉じる。
   */
  export async function createOffloaded<PE = unknown, PS = unknown>(
    input: SqliteEventStoreInput<PE, PS>,
    execution: SqliteBlockingExecution,
  ): Promise<Result<SqliteEventStore<PE, PS>, EventStoreError>> {
    return openOffloadedSqliteEventStoreInternal(input, execution);
  }
}

Object.freeze(SqliteEventStore);
