import { type Database, protos, type Transaction } from "@google-cloud/spanner";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SpannerEventStoreHooks } from "./spanner-event-store-hooks";
import {
  decideRetryWait,
  type RetryClock,
  retryClock,
  waitForRetry,
} from "./spanner-retry-wait";
import { SpannerTransactionRejection } from "./spanner-transaction-rejection";

// gRPC の ABORTED
const ABORTED = 10;

const isAborted = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === ABORTED;

/**
 * SERIALIZABLE の読み書きトランザクションを試行ごとに取り直して実行する（SPN-1・SPN-7）。
 * ABORTED は retryLimit 回まで（初回は数えない）やり直し、超えたら保存先エラーにする。
 * 試行の中では採番も外部への通知もしない。
 */
export async function runSpannerReadWriteTransaction<T>(
  database: Database,
  retryLimit: number,
  attempt: (transaction: Transaction) => Promise<T>,
  hooks?: Pick<SpannerEventStoreHooks, "beforeCommit" | "afterCommit">,
  clock: RetryClock = retryClock,
): Promise<Result<T, EventStoreError>> {
  for (let retries = 0; ; retries += 1) {
    let transaction: Transaction;
    try {
      [transaction] = await database.getTransaction({
        isolationLevel:
          protos.google.spanner.v1.TransactionOptions.IsolationLevel
            .SERIALIZABLE,
      });
    } catch (cause) {
      // 取得できなかった試行には、解放するトランザクションがない。やり直さず保存先エラーにする。
      return Result.err(
        EventStoreError.storage("transaction could not be started", cause),
      );
    }
    let committed = false;
    let abortedCause: unknown;
    try {
      const value = await attempt(transaction);
      await hooks?.beforeCommit?.();
      await transaction.commit();
      committed = true;
      await hooks?.afterCommit?.();
      return Result.ok(value);
    } catch (cause) {
      if (committed) {
        // SPN-8: コミット後に応答を失った。確定していないと断定せず、補償も再実行もしない。
        return Result.err(
          EventStoreError.storage("commit outcome unknown", cause),
        );
      }
      if (cause instanceof SpannerTransactionRejection) {
        await rollback(transaction);
        return Result.err(cause.error);
      }
      if (isAborted(cause)) {
        // 中断されたトランザクションを解放してから、次の試行を取り直す。
        await rollback(transaction);
        abortedCause = cause;
      } else {
        await rollback(transaction);
        return Result.err(EventStoreError.storage("transaction failed", cause));
      }
    } finally {
      transaction.end();
    }
    if (retries >= retryLimit) {
      return Result.err(
        EventStoreError.storage(
          "transaction aborted; retry limit exceeded",
          abortedCause,
        ),
      );
    }
    const wait = decideRetryWait(abortedCause, retries + 1, clock.random);
    if (wait.kind === "stop") {
      return Result.err(
        EventStoreError.storage(
          "server retry delay exceeds supported wait of 60000ms",
          abortedCause,
        ),
      );
    }
    try {
      await waitForRetry(wait.milliseconds, clock);
    } catch (cause) {
      return Result.err(
        EventStoreError.storage("transaction retry wait failed", cause),
      );
    }
  }
}

async function rollback(transaction: Transaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // ロールバックの失敗は握りつぶす。呼び出し元へ返す元の失敗が主であり、
    // 未確定のトランザクションは end() でサーバー側の期限切れに任せられる。
  }
}
