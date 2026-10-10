import { EventStoreError } from "../event-store-error";
import { Result } from "../result";

export function validateSeqNr(seqNr: unknown): Result<number, EventStoreError> {
  if (typeof seqNr === "number" && Number.isSafeInteger(seqNr) && seqNr >= 0) {
    return Result.ok(seqNr);
  }
  return Result.err(
    EventStoreError.contractViolation({
      rule: "T-9",
      detail: `seqNr must be an integer between 0 and ${Number.MAX_SAFE_INTEGER}`,
      ...(typeof seqNr === "number" ? { seqNr } : {}),
    }),
  );
}
