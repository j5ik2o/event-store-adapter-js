import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { validateSeqNr } from "./seq-nr-validation";
import { spannerAggregateKey } from "./spanner-aggregate-key";
import type { SpannerEventStoreHooks } from "./spanner-event-store-hooks";
import type { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";
import { spannerRows } from "./spanner-rows";
import { spannerStoredInteger } from "./spanner-stored-integer";
import { validateAggregateId } from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateSpannerEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

const NANOS_PER_MILLI = BigInt(1000000);
const MIN_NANOS = BigInt("-9223372036854775808");
const MAX_NANOS = BigInt("9223372036854775807");
const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

export function createSpannerGetEvents<PE, PS>(
  settings: Settings<PE, PS>,
  hooks?: SpannerEventStoreHooks,
): EventStore<PE, PS>["getEventsByIdSinceSeqNr"] {
  return async (aggregateId, seqNr) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    const start = validateSeqNr(seqNr);
    if (start.type === "err") return start;
    const { hashPrefix, aid } = spannerAggregateKey(validatedId.value);
    const key = { hp: hashPrefix, aid };
    const keyTypes = { hp: "bytes", aid: "string" };

    try {
      await hooks?.beforeReadEvents?.();
      // SPN-10: ヘッドの h を固定し、同じ strong の読み取り専用トランザクションで journal を読む。
      const [snapshot] = await settings.database.getSnapshot({ strong: true });
      let rows: readonly Record<string, unknown>[];
      let head: bigint;
      try {
        const heads = await spannerRows(
          snapshot,
          `SELECT seq_nr FROM \`${settings.tables.head}\` WHERE hash_prefix = @hp AND aid = @aid`,
          key,
          keyTypes,
        );
        if (heads.length === 0) return Result.ok([]);
        const stored = spannerStoredInteger(
          heads[0].seq_nr,
          "head seq_nr",
          BigInt(1),
          MAX_SEQ_NR,
        );
        if (stored.type === "err") return stored;
        head = stored.value;
        const from = BigInt(Math.max(1, start.value));
        if (from > head) return Result.ok([]);
        rows = await spannerRows(
          snapshot,
          `SELECT seq_nr, occurred_at_ns, manifest, payload FROM \`${settings.tables.journal}\` WHERE hash_prefix = @hp AND aid = @aid AND seq_nr >= @from AND seq_nr <= @head ORDER BY seq_nr ASC`,
          { ...key, from: from.toString(), head: head.toString() },
          { ...keyTypes, from: "int64", head: "int64" },
        );
        if (BigInt(rows.length) !== head - from + BigInt(1))
          return Result.err(
            EventStoreError.storage("event journal range has a gap"),
          );
        const events: EventEnvelope<PE>[] = [];
        for (const [index, row] of rows.entries()) {
          const restored = restoreEvent(
            row,
            from + BigInt(index),
            validatedId.value,
            settings.eventSerializer,
          );
          if (restored.type === "err") return restored;
          events.push(restored.value);
        }
        return Result.ok(events);
      } finally {
        snapshot.end();
      }
    } catch (cause) {
      return Result.err(
        EventStoreError.storage("event journal query failed", cause),
      );
    }
  };
}

function restoreEvent<P>(
  row: Record<string, unknown>,
  expectedSeqNr: bigint,
  aggregateId: EventEnvelope<P>["aggregateId"],
  serializer: Settings<P, unknown>["eventSerializer"],
): Result<EventEnvelope<P>, EventStoreError> {
  const seqNr = spannerStoredInteger(
    row.seq_nr,
    "journal seq_nr",
    expectedSeqNr,
    expectedSeqNr,
  );
  if (seqNr.type === "err") return seqNr;
  const nanos = spannerStoredInteger(
    row.occurred_at_ns,
    "journal occurred_at_ns",
    MIN_NANOS,
    MAX_NANOS,
  );
  if (nanos.type === "err") return nanos;
  const manifest = row.manifest;
  const bytes = row.payload;
  if (typeof manifest !== "string" || !(bytes instanceof Uint8Array))
    return Result.err(
      EventStoreError.storage("invalid journal manifest or payload"),
    );
  // ナノ秒からミリ秒へは切り捨てる（負の値は負の無限大方向）。
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
