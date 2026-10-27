import { EventStoreError } from "../event-store-error";
import { Result } from "../result";

/** 読み取った整数を number を経由せずに検査する。bigint だけを受ける。 */
export function sqliteStoredInteger(
  raw: unknown,
  field: string,
  min: bigint,
  max: bigint,
): Result<bigint, EventStoreError> {
  if (typeof raw !== "bigint" || raw < min || raw > max)
    return Result.err(EventStoreError.storage(`invalid ${field}`));
  return Result.ok(raw);
}
