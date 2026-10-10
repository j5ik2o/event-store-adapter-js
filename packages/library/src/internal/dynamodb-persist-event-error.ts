import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { EventStoreError } from "../event-store-error";

export function classifyDynamoDBPersistEventError(
  cause: unknown,
  aggregateId: string,
  seqNr: number,
): EventStoreError {
  const storage = () =>
    EventStoreError.storage("event transaction failed", cause);
  if (!(cause instanceof TransactionCanceledException)) return storage();
  const reasons = cause.CancellationReasons;
  if (reasons?.some(({ Code }) => Code === "TransactionConflict"))
    return EventStoreError.optimisticLockConflict({
      aggregateId,
      seqNr,
      cause,
    });

  // action 0はjournal、action 1はhead。Noneを取り除いて位置を変えない。
  const head = reasons?.[1];
  if (head?.Code === "ConditionalCheckFailed") {
    let headSeqNr = 0;
    if (head.Item !== undefined) {
      const oldSeqNr = head.Item.seq_nr?.N;
      if (oldSeqNr === undefined || !/^\d+$/.test(oldSeqNr)) return storage();
      headSeqNr = Number(oldSeqNr);
      if (!Number.isSafeInteger(headSeqNr) || headSeqNr < 1) return storage();
    }
    if (seqNr === 1 || seqNr <= headSeqNr)
      return EventStoreError.optimisticLockConflict({
        aggregateId,
        seqNr,
        headSeqNr,
        cause,
      });
    if (seqNr >= headSeqNr + 2)
      return EventStoreError.contractViolation({ rule: "W-8", seqNr, cause });
    return storage();
  }
  if (reasons?.[0]?.Code === "ConditionalCheckFailed")
    return EventStoreError.optimisticLockConflict({
      aggregateId,
      seqNr,
      cause,
    });
  return storage();
}
