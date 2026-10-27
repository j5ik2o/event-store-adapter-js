import { AggregateId } from "../aggregate-id";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { validateSeqNr } from "./seq-nr-validation";
import {
  type SqliteConnectionState,
  usableSqliteConnection,
} from "./sqlite-connection-state";
import type { SqliteEventStoreHooks } from "./sqlite-event-store-hooks";
import type { validateSqliteEventStoreInput } from "./sqlite-event-store-input-validation";
import { sqliteStoredInteger } from "./sqlite-stored-integer";
import { endSqliteTransaction } from "./sqlite-transaction";
import { validateAggregateId } from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateSqliteEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

const NANOS_PER_MILLI = BigInt(1000000);
const MIN_NANOS = BigInt("-9223372036854775808");
const MAX_NANOS = BigInt("9223372036854775807");
const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

type JournalRow = Readonly<Record<string, unknown>>;

export function createSqliteGetEvents<PE, PS>(
  connection: SqliteConnectionState,
  settings: Settings<PE, PS>,
  hooks?: SqliteEventStoreHooks,
): EventStore<PE, PS>["getEventsByIdSinceSeqNr"] {
  return async (aggregateId, seqNr) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    const start = validateSeqNr(seqNr);
    if (start.type === "err") return start;
    const aid = AggregateId.asString(validatedId.value);
    if (aid.type === "err") return aid;
    const usable = usableSqliteConnection(connection);
    if (usable.type === "err") return usable;
    const db = usable.value;

    let head: bigint;
    let from: bigint;
    let rows: readonly JournalRow[];
    try {
      // SQ-9: ヘッドと journal を、1 つの明示的な読み取りトランザクションで読む。
      db.exec("BEGIN");
      try {
        const heads = db.prepare("SELECT seq_nr FROM head WHERE aid = ?");
        heads.setReadBigInts(true);
        const headRow = heads.get(aid.value);
        hooks?.afterReadHead?.("events");
        if (headRow === undefined) return Result.ok([]);
        const stored = sqliteStoredInteger(
          headRow.seq_nr,
          "head seq_nr",
          BigInt(1),
          MAX_SEQ_NR,
        );
        if (stored.type === "err") return stored;
        head = stored.value;
        from = BigInt(Math.max(1, start.value));
        if (from > head) return Result.ok([]);
        const journal = db.prepare(
          "SELECT seq_nr, occurred_at_ns, manifest, payload FROM journal WHERE aid = ? AND seq_nr >= ? AND seq_nr <= ? ORDER BY seq_nr",
        );
        journal.setReadBigInts(true);
        rows = journal.all(aid.value, from, head);
      } finally {
        endSqliteTransaction(db);
      }
    } catch (cause) {
      return Result.err(
        EventStoreError.storage("event journal query failed", cause),
      );
    }
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
  };
}

function restoreEvent<P>(
  row: JournalRow,
  expectedSeqNr: bigint,
  aggregateId: EventEnvelope<P>["aggregateId"],
  serializer: Settings<P, unknown>["eventSerializer"],
): Result<EventEnvelope<P>, EventStoreError> {
  const seqNr = sqliteStoredInteger(
    row.seq_nr,
    "journal seq_nr",
    expectedSeqNr,
    expectedSeqNr,
  );
  if (seqNr.type === "err") return seqNr;
  const nanos = sqliteStoredInteger(
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
