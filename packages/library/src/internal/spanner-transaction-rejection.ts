import type { EventStoreError } from "../event-store-error";

/** 試行の中で、コミットせずに呼び出し元へ返す失敗（楽観ロック・契約違反など）を表す。 */
export class SpannerTransactionRejection extends Error {
  constructor(readonly error: EventStoreError) {
    super(error.message);
  }
}
