import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { Result } from "../../result";
import type { AggregateId } from "../aggregate-id";
import type { EventEnvelope } from "../event-envelope";
import { EventStoreError } from "../event-store-error";
import type { PayloadSerializer } from "../payload-serializer";

const NANOS_PER_MILLI = BigInt(1000000);
const MIN_NANOS = BigInt("-9223372036854775808");
const MAX_NANOS = BigInt("9223372036854775807");

function storedInteger(
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
    return Result.err(EventStoreError.storage(`invalid journal ${field}`));

  // Nは小数・指数表記でも返り得る。整数性を浮動小数点へ変換せずに判定する。
  const fraction = match[3] ?? "";
  const digits = match[2] + fraction;
  const coefficient = BigInt(match[1] + digits);
  const scale = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  let value = coefficient;
  if (coefficient !== BigInt(0)) {
    if (scale >= BigInt(0)) {
      if (scale > BigInt(max.toString().length))
        return Result.err(EventStoreError.storage(`invalid journal ${field}`));
      value = coefficient * BigInt(`1${"0".repeat(Number(scale))}`);
    } else {
      if (-scale > BigInt(digits.length))
        return Result.err(EventStoreError.storage(`invalid journal ${field}`));
      const divisor = BigInt(`1${"0".repeat(Number(-scale))}`);
      if (coefficient % divisor !== BigInt(0))
        return Result.err(EventStoreError.storage(`invalid journal ${field}`));
      value = coefficient / divisor;
    }
  }
  if (value < min || value > max)
    return Result.err(EventStoreError.storage(`invalid journal ${field}`));
  return Result.ok(value);
}

export function restoreDynamoDBEventEnvelope<P>(
  item: Record<string, AttributeValue>,
  aggregateId: AggregateId,
  serializer: PayloadSerializer<P>,
): Result<EventEnvelope<P>, EventStoreError> {
  const aid = `${aggregateId.typeName}-${aggregateId.value}`;
  if (item.aid?.S !== aid)
    return Result.err(EventStoreError.storage("invalid journal aid"));
  const seqNr = storedInteger(
    item.seq_nr?.N,
    "seq_nr",
    BigInt(1),
    BigInt(Number.MAX_SAFE_INTEGER),
  );
  if (seqNr.type === "err") return seqNr;
  const nanos = storedInteger(
    item.occurred_at?.N,
    "occurred_at",
    MIN_NANOS,
    MAX_NANOS,
  );
  if (nanos.type === "err") return nanos;
  const manifest = item.manifest?.S;
  const bytes = item.payload?.B;
  if (typeof manifest !== "string" || !(bytes instanceof Uint8Array))
    return Result.err(
      EventStoreError.storage("invalid journal manifest or payload"),
    );

  const millis =
    nanos.value / NANOS_PER_MILLI -
    (nanos.value % NANOS_PER_MILLI < BigInt(0) ? BigInt(1) : BigInt(0));
  try {
    const payload = serializer.deserialize(new Uint8Array(bytes), manifest);
    return Result.ok(
      Object.freeze({
        aggregateId,
        seqNr: Number(seqNr.value),
        occurredAt: new Date(Number(millis)),
        manifest,
        payload,
      }),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.serialization(
        "deserialize",
        "event payload deserialization failed",
        cause,
      ),
    );
  }
}
