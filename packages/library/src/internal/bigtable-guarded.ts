import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { isEventStoreError } from "./bigtable-event-store-error-guard";

/**
 * 内部の処理は失敗を EventStoreError として投げる。公開の操作の境界で Result に変える。
 * EventStoreError でない失敗（SDK や試験用フックの失敗）は、保存先エラーにする。
 */
export async function guarded<T>(
  message: string,
  work: () => Promise<Result<T, EventStoreError>>,
): Promise<Result<T, EventStoreError>> {
  try {
    return await work();
  } catch (cause) {
    return Result.err(
      isEventStoreError(cause)
        ? cause
        : EventStoreError.storage(message, cause),
    );
  }
}
