import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { Result } from "../../result";
import type { AggregateId } from "../aggregate-id";
import type { EventEnvelope } from "../event-envelope";
import { EventStoreError } from "../event-store-error";
import type { PayloadSerializer } from "../payload-serializer";
import { dynamoDBStoredInteger } from "./dynamodb-stored-integer";

const NANOS_PER_MILLI = BigInt(1000000);
const MIN_NANOS = BigInt("-9223372036854775808");
const MAX_NANOS = BigInt("9223372036854775807");

export function restoreDynamoDBEventEnvelope<P>(
  item: Record<string, AttributeValue>,
  aggregateId: AggregateId,
  serializer: PayloadSerializer<P>,
): Result<EventEnvelope<P>, EventStoreError> {
  const aid = `${aggregateId.typeName}-${aggregateId.value}`;
  if (item.aid?.S !== aid)
    return Result.err(EventStoreError.storage("invalid journal aid"));
  const seqNr = dynamoDBStoredInteger(
    item.seq_nr?.N,
    "journal seq_nr",
    BigInt(1),
    BigInt(Number.MAX_SAFE_INTEGER),
  );
  if (seqNr.type === "err") return seqNr;
  const nanos = dynamoDBStoredInteger(
    item.occurred_at?.N,
    "journal occurred_at",
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
