import type { DatabaseSync } from "node:sqlite";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { notifyRetentionFailure } from "./retention-failure-notification";
import {
  type SqliteConnectionState,
  usableSqliteConnection,
} from "./sqlite-connection-state";
import { sqliteErrorCode } from "./sqlite-error-code";
import type { SqliteEventStoreHooks } from "./sqlite-event-store-hooks";
import type { validateSqliteEventStoreInput } from "./sqlite-event-store-input-validation";
import { retainSqliteSnapshots } from "./sqlite-snapshot-retention";
import { sqliteStoredInteger } from "./sqlite-stored-integer";
import { endSqliteTransaction } from "./sqlite-transaction";
import {
  validateEvent,
  validateEventAndSnapshot,
} from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateSqliteEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

const NANOS_PER_MILLI = BigInt(1000000);
const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function createSqlitePersistEvent<PE, PS>(
  connection: SqliteConnectionState,
  settings: Settings<PE, PS>,
  hooks?: SqliteEventStoreHooks,
): EventStore<PE, PS>["persistEvent"] {
  return async (event) => {
    const validated = validateEvent(event);
    if (validated.type === "err") return validated;
    return persistSqliteEvent(
      connection,
      settings,
      validated.value,
      undefined,
      hooks,
    );
  };
}

export function createSqlitePersistEventAndSnapshot<PE, PS>(
  connection: SqliteConnectionState,
  settings: Settings<PE, PS>,
  hooks?: SqliteEventStoreHooks,
): EventStore<PE, PS>["persistEventAndSnapshot"] {
  return async (event, snapshot) => {
    const validated = validateEventAndSnapshot(event, snapshot);
    if (validated.type === "err") return validated;
    return persistSqliteEvent(
      connection,
      settings,
      validated.value.event,
      validated.value.snapshot,
      hooks,
    );
  };
}

function serialize<P>(
  serializer: { serialize(payload: P): Uint8Array },
  payload: P,
  what: string,
): Result<Buffer, EventStoreError> {
  try {
    const serialized = serializer.serialize(payload);
    if (!(serialized instanceof Uint8Array))
      throw new TypeError("serializer.serialize must return Uint8Array");
    return Result.ok(Buffer.from(serialized));
  } catch (cause) {
    return Result.err(
      EventStoreError.serialization(
        "serialize",
        `${what} payload serialization failed`,
        cause,
      ),
    );
  }
}

type Rows = Readonly<{
  aid: string;
  typeName: string;
  seqNr: number;
  nanos: bigint;
  manifest: string;
  payload: Buffer;
  snapshot:
    | Readonly<{ seqNr: number; manifest: string; payload: Buffer }>
    | undefined;
  keepHistory: boolean;
}>;

/**
 * BEGIN IMMEDIATE → ヘッドの読み取り → 照合 → 書き込み → COMMIT を、await を挟まずに同期で行う
 * （SQ-5・SQ-6・SQ-17）。失敗は ROLLBACK して結果で返す。
 */
function appendInTransaction(
  db: DatabaseSync,
  rows: Rows,
  hooks: SqliteEventStoreHooks | undefined,
): Result<void, EventStoreError> {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (cause) {
    // SQ-7: BUSY・LOCKED・待ち時間の超過は保存先エラーで、楽観ロックにしない。
    return Result.err(
      EventStoreError.storage("write lock could not be acquired", cause),
    );
  }
  try {
    const select = db.prepare("SELECT seq_nr FROM head WHERE aid = ?");
    select.setReadBigInts(true);
    const head = select.get(rows.aid);
    let headSeqNr = BigInt(0);
    if (head !== undefined) {
      const stored = sqliteStoredInteger(
        head.seq_nr,
        "head seq_nr",
        BigInt(1),
        MAX_SEQ_NR,
      );
      if (stored.type === "err") {
        endSqliteTransaction(db);
        return stored;
      }
      headSeqNr = stored.value;
    }
    hooks?.afterHeadRead?.();
    const next = BigInt(rows.seqNr);
    if (next <= headSeqNr) {
      endSqliteTransaction(db);
      return Result.err(
        EventStoreError.optimisticLockConflict({
          aggregateId: rows.aid,
          seqNr: rows.seqNr,
          headSeqNr: Number(headSeqNr),
        }),
      );
    }
    if (next !== headSeqNr + BigInt(1)) {
      endSqliteTransaction(db);
      return Result.err(
        EventStoreError.contractViolation({ rule: "W-8", seqNr: rows.seqNr }),
      );
    }
    try {
      db.prepare(
        "INSERT INTO journal (aid, seq_nr, occurred_at_ns, manifest, payload) VALUES (?, ?, ?, ?, ?)",
      ).run(rows.aid, next, rows.nanos, rows.manifest, rows.payload);
      if (head === undefined) {
        db.prepare(
          "INSERT INTO head (aid, type_name, seq_nr, event_occurred_at_ns, event_manifest, event_payload) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          rows.aid,
          rows.typeName,
          next,
          rows.nanos,
          rows.manifest,
          rows.payload,
        );
      } else {
        db.prepare(
          "UPDATE head SET seq_nr = ?, event_occurred_at_ns = ?, event_manifest = ?, event_payload = ? WHERE aid = ?",
        ).run(next, rows.nanos, rows.manifest, rows.payload, rows.aid);
      }
    } catch (cause) {
      // 主キーの重複は楽観ロックの競合として扱う。それ以外は保存先エラー。
      const code = sqliteErrorCode(cause);
      if (
        code === SQLITE_CONSTRAINT_PRIMARYKEY ||
        code === SQLITE_CONSTRAINT_UNIQUE
      ) {
        endSqliteTransaction(db);
        return Result.err(
          EventStoreError.optimisticLockConflict({
            aggregateId: rows.aid,
            seqNr: rows.seqNr,
            cause,
          }),
        );
      }
      throw cause;
    }
    if (rows.snapshot !== undefined) {
      const snapshotSeq = BigInt(rows.snapshot.seqNr);
      db.prepare(
        "INSERT INTO snapshot_current (aid, seq_nr, manifest, payload) VALUES (?, ?, ?, ?) ON CONFLICT(aid) DO UPDATE SET seq_nr = excluded.seq_nr, manifest = excluded.manifest, payload = excluded.payload",
      ).run(
        rows.aid,
        snapshotSeq,
        rows.snapshot.manifest,
        rows.snapshot.payload,
      );
      if (rows.keepHistory)
        db.prepare(
          "INSERT INTO snapshot_history (aid, seq_nr, manifest, payload) VALUES (?, ?, ?, ?)",
        ).run(
          rows.aid,
          snapshotSeq,
          rows.snapshot.manifest,
          rows.snapshot.payload,
        );
    }
    hooks?.beforeCommit?.();
    // COMMIT の成功が確定点。失敗したら確定したか分からないので、採番し直さず保存先エラーにする（SQ-6）。
    db.exec("COMMIT");
    return Result.ok(undefined);
  } catch (cause) {
    endSqliteTransaction(db);
    return Result.err(EventStoreError.storage("event append failed", cause));
  }
}

async function persistSqliteEvent<PE, PS>(
  connection: SqliteConnectionState,
  settings: Settings<PE, PS>,
  event: EventEnvelope<PE>,
  snapshot: SnapshotEnvelope<PS> | undefined,
  hooks?: SqliteEventStoreHooks,
): Promise<Result<void, EventStoreError>> {
  // 検証済みの ID なので、文字列の組み立てで失敗しない。
  const aid = `${event.aggregateId.typeName}-${event.aggregateId.value}`;
  const eventBytes = serialize(
    settings.eventSerializer,
    event.payload,
    "event",
  );
  if (eventBytes.type === "err") return eventBytes;
  const snapshotBytes =
    snapshot === undefined
      ? undefined
      : serialize(settings.snapshotSerializer, snapshot.aggregate, "snapshot");
  if (snapshotBytes?.type === "err") return snapshotBytes;
  const db = usableSqliteConnection(connection);
  if (db.type === "err") return db;

  const result = appendInTransaction(
    db.value,
    {
      aid,
      typeName: event.aggregateId.typeName,
      seqNr: event.seqNr,
      nanos: BigInt(event.occurredAt.getTime()) * NANOS_PER_MILLI,
      manifest: event.manifest,
      payload: eventBytes.value,
      snapshot:
        snapshot === undefined || snapshotBytes === undefined
          ? undefined
          : {
              seqNr: snapshot.seqNr,
              manifest: snapshot.manifest,
              payload: snapshotBytes.value,
            },
      keepHistory: settings.retentionCount !== undefined,
    },
    hooks,
  );
  if (result.type === "err") return result;

  if (snapshot !== undefined && settings.retentionCount !== undefined) {
    // SQ-11: 整理の失敗は、確定済みの追記の成功を変えず、別の経路で通知する。
    const retained = retainSqliteSnapshots(
      db.value,
      aid,
      snapshot.seqNr,
      settings.retentionCount,
      hooks,
    );
    if (retained.type === "err")
      await notifyRetentionFailure(
        aid,
        retained.error,
        settings.logger,
        settings.onRetentionFailure,
      );
  }
  return Result.ok(undefined);
}
