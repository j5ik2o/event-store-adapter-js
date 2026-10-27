import type { EventStore } from "./event-store";
import type { EventStoreError } from "./event-store-error";
import {
  initializeSqliteStoreInternal,
  openSqliteEventStoreInternal,
} from "./internal/sqlite-event-store";
import type { Result } from "./result";
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

  /** 初期化済みのファイルを照合して開く。接続はこのストアが所有し、`close` で閉じる。 */
  export async function create<PE = unknown, PS = unknown>(
    input: SqliteEventStoreInput<PE, PS>,
  ): Promise<Result<SqliteEventStore<PE, PS>, EventStoreError>> {
    return openSqliteEventStoreInternal(input);
  }
}

Object.freeze(SqliteEventStore);
