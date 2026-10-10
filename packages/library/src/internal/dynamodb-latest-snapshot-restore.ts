import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { AggregateId } from "../aggregate-id";
import { EventStoreError } from "../event-store-error";
import type { LatestSnapshot } from "../latest-snapshot";
import type { PayloadSerializer } from "../payload-serializer";
import { Result } from "../result";
import { dynamoDBStoredInteger } from "./dynamodb-stored-integer";

const MIN_NANOS = BigInt("-9223372036854775808");
const MAX_NANOS = BigInt("9223372036854775807");
const NANOS_PER_MILLI = BigInt(1000000);

export function restoreDynamoDBLatestSnapshot<S>(
  head: Record<string, AttributeValue> | undefined,
  current: Record<string, AttributeValue> | undefined,
  aggregateId: AggregateId,
  serializer: PayloadSerializer<S>,
): Result<LatestSnapshot<S> | undefined, EventStoreError> {
  if (head === undefined) return Result.ok(undefined);
  const aid = `${aggregateId.typeName}-${aggregateId.value}`;
  if (head.aid?.S !== aid || head.type_name?.S !== aggregateId.typeName)
    return Result.err(EventStoreError.storage("invalid head aid or type_name"));
  const headSeqNr = dynamoDBStoredInteger(
    head.seq_nr?.N,
    "head seq_nr",
    BigInt(1),
    BigInt(Number.MAX_SAFE_INTEGER),
  );
  if (headSeqNr.type === "err") return headSeqNr;
  const events = head.events?.L;
  const event = events?.[0]?.M;
  if (events?.length !== 1 || event === undefined)
    return Result.err(EventStoreError.storage("invalid head events"));
  const eventSeqNr = dynamoDBStoredInteger(
    event.seq_nr?.N,
    "head event seq_nr",
    headSeqNr.value,
    headSeqNr.value,
  );
  if (eventSeqNr.type === "err") return eventSeqNr;
  const nanos = dynamoDBStoredInteger(
    event.occurred_at?.N,
    "head event occurred_at",
    MIN_NANOS,
    MAX_NANOS,
  );
  if (nanos.type === "err") return nanos;
  if (
    typeof event.manifest?.S !== "string" ||
    !(event.payload?.B instanceof Uint8Array)
  )
    return Result.err(
      EventStoreError.storage("invalid head event manifest or payload"),
    );

  if (current === undefined)
    return Result.ok(Object.freeze({ headSeqNr: Number(headSeqNr.value) }));
  if (current.aid?.S !== aid)
    return Result.err(EventStoreError.storage("invalid snapshot aid"));
  const skey = dynamoDBStoredInteger(
    current.skey?.N,
    "snapshot skey",
    BigInt(0),
    BigInt(0),
  );
  if (skey.type === "err") return skey;
  const seqNr = dynamoDBStoredInteger(
    current.seq_nr?.N,
    "snapshot seq_nr",
    BigInt(0),
    BigInt(Number.MAX_SAFE_INTEGER),
  );
  if (seqNr.type === "err") return seqNr;
  const updatedAt = dynamoDBStoredInteger(
    current.last_updated_at?.N,
    "snapshot last_updated_at",
    MIN_NANOS / NANOS_PER_MILLI - BigInt(1),
    MAX_NANOS / NANOS_PER_MILLI,
  );
  if (updatedAt.type === "err") return updatedAt;
  const manifest = current.manifest?.S;
  const bytes = current.payload?.B;
  if (typeof manifest !== "string" || !(bytes instanceof Uint8Array))
    return Result.err(
      EventStoreError.storage("invalid snapshot manifest or payload"),
    );

  // DY-9・R-8: BatchGetItemは非原子的。headとsnapshotの番号は相互比較しない。
  try {
    const aggregate = serializer.deserialize(new Uint8Array(bytes), manifest);
    return Result.ok(
      Object.freeze({
        headSeqNr: Number(headSeqNr.value),
        snapshot: Object.freeze({
          seqNr: Number(seqNr.value),
          manifest,
          aggregate,
        }),
      }),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.serialization(
        "deserialize",
        "snapshot payload deserialization failed",
        cause,
      ),
    );
  }
}
