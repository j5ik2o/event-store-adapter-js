import type { BigtableJournalWriteFailure } from "../bigtable-journal-write-failure";
import type { Logger } from "../logger";
import { logNotificationFailure } from "./retention-failure-notification";

/**
 * 確定後の末尾の書き出しの失敗を、logger とコールバックへ知らせる。通知の失敗を、確定した追記へ戻さない。
 */
export async function notifyJournalWriteFailure(
  aggregateId: string,
  seqNr: number,
  cause: unknown,
  logger: Logger = console,
  onJournalWriteFailure?: (failure: BigtableJournalWriteFailure) => void,
): Promise<void> {
  const failure: BigtableJournalWriteFailure = Object.freeze({
    kind: "journal-write-failure",
    aggregateId,
    seqNr,
    cause,
  });
  try {
    await logger.error(failure);
  } catch (notificationCause) {
    await logNotificationFailure(logger, notificationCause);
  }
  try {
    await onJournalWriteFailure?.(failure);
  } catch (notificationCause) {
    await logNotificationFailure(logger, notificationCause);
  }
}
