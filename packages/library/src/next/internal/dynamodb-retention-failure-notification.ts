import type { Logger } from "../../logger";
import type { RetentionFailure } from "../retention-failure";

async function logNotificationFailure(
  logger: Logger,
  cause: unknown,
): Promise<void> {
  try {
    await logger.error("retention failure notification failed", cause);
  } catch (loggingCause) {
    try {
      console.error(
        "retention failure notification logging failed",
        cause,
        loggingCause,
      );
    } catch {
      // 両通知先の失敗でも、確定済みの成功は変更しない。
    }
  }
}

export async function notifyDynamoDBRetentionFailure(
  aggregateId: string,
  cause: unknown,
  logger: Logger = console,
  onRetentionFailure?: (failure: RetentionFailure) => void,
): Promise<void> {
  const failure: RetentionFailure = Object.freeze({
    kind: "retention-failure",
    aggregateId,
    cause,
  });
  try {
    await logger.error(failure);
  } catch (notificationCause) {
    await logNotificationFailure(logger, notificationCause);
  }
  try {
    await onRetentionFailure?.(failure);
  } catch (notificationCause) {
    await logNotificationFailure(logger, notificationCause);
  }
}
