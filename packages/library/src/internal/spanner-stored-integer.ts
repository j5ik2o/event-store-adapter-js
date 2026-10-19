import { EventStoreError } from "../event-store-error";
import { Result } from "../result";

const DECIMAL = /^-?\d+$/;

/**
 * Spanner の INT64 を number を経由せずに復元する。
 * wrapNumbers の `{ value: "…" }`、10 進文字列、bigint だけを受ける。
 */
export function spannerStoredInteger(
  raw: unknown,
  field: string,
  min: bigint,
  max: bigint,
): Result<bigint, EventStoreError> {
  const text =
    typeof raw === "bigint"
      ? raw.toString()
      : typeof raw === "string"
        ? raw
        : typeof raw === "object" &&
            raw !== null &&
            typeof (raw as { value?: unknown }).value === "string"
          ? (raw as { value: string }).value
          : undefined;
  if (text === undefined || !DECIMAL.test(text))
    return Result.err(EventStoreError.storage(`invalid ${field}`));
  const value = BigInt(text);
  if (value < min || value > max)
    return Result.err(EventStoreError.storage(`invalid ${field}`));
  return Result.ok(value);
}
