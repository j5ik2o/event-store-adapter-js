import type { BigtableEventStoreInput } from "./bigtable-event-store-input";
import type { EventStore } from "./event-store";
import type { EventStoreError } from "./event-store-error";
import {
  initializeBigtableStoreInternal,
  openBigtableEventStoreInternal,
} from "./internal/bigtable-event-store";
import type { Result } from "./result";

export namespace BigtableEventStore {
  /** 用意済みの 2 つのテーブルに設定行を作る（BT-D1）。テーブルと列ファミリは作らない。 */
  export async function initialize<PE = unknown, PS = unknown>(
    input: BigtableEventStoreInput<PE, PS>,
  ): Promise<Result<void, EventStoreError>> {
    return initializeBigtableStoreInternal(input);
  }

  /** 列ファミリと設定行を照合して開く。初期化はしない。クライアントは呼び出し側が所有し、閉じる。 */
  export async function create<PE = unknown, PS = unknown>(
    input: BigtableEventStoreInput<PE, PS>,
  ): Promise<Result<EventStore<PE, PS>, EventStoreError>> {
    return openBigtableEventStoreInternal(input);
  }
}

Object.freeze(BigtableEventStore);
