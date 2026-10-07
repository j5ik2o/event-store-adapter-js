import { Result } from "../../result";
import { EventStoreError } from "../event-store-error";

const NANOS_PER_MILLI = BigInt(1000000);
const MIN_NANOS = BigInt("-9223372036854775808");
const MAX_NANOS = BigInt("9223372036854775807");

export function validateOccurredAt(
  occurredAt: unknown,
  seqNr?: number,
): Result<Date, EventStoreError> {
  const violation = (detail: string) =>
    Result.err(
      EventStoreError.contractViolation({
        rule: "T-13",
        detail,
        ...(seqNr !== undefined ? { seqNr } : {}),
      }),
    );
  if (!(occurredAt instanceof Date)) {
    return violation("occurredAt must be a Date");
  }
  const millis = occurredAt.getTime();
  if (Number.isNaN(millis)) {
    return violation("occurredAt must be a valid Date");
  }
  const nanos = BigInt(millis) * NANOS_PER_MILLI;
  if (nanos < MIN_NANOS || nanos > MAX_NANOS) {
    return violation(
      "occurredAt must fit in signed 64-bit nanoseconds since the epoch",
    );
  }
  return Result.ok(new Date(millis));
}
