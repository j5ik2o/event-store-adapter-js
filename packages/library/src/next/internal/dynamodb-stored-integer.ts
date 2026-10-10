import { Result } from "../../result";
import { EventStoreError } from "../event-store-error";

export function dynamoDBStoredInteger(
  raw: string | undefined,
  field: string,
  min: bigint,
  max: bigint,
): Result<bigint, EventStoreError> {
  const match =
    typeof raw === "string"
      ? /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw)
      : null;
  if (match === null)
    return Result.err(EventStoreError.storage(`invalid ${field}`));

  // Nは小数・指数表記でも返り得る。整数性を浮動小数点へ変換せずに判定する。
  const fraction = match[3] ?? "";
  const digits = match[2] + fraction;
  const coefficient = BigInt(match[1] + digits);
  const scale = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  let value = coefficient;
  if (coefficient !== BigInt(0)) {
    if (scale >= BigInt(0)) {
      if (scale > BigInt(max.toString().length))
        return Result.err(EventStoreError.storage(`invalid ${field}`));
      value = coefficient * BigInt(`1${"0".repeat(Number(scale))}`);
    } else {
      if (-scale > BigInt(digits.length))
        return Result.err(EventStoreError.storage(`invalid ${field}`));
      const divisor = BigInt(`1${"0".repeat(Number(-scale))}`);
      if (coefficient % divisor !== BigInt(0))
        return Result.err(EventStoreError.storage(`invalid ${field}`));
      value = coefficient / divisor;
    }
  }
  if (value < min || value > max)
    return Result.err(EventStoreError.storage(`invalid ${field}`));
  return Result.ok(value);
}
