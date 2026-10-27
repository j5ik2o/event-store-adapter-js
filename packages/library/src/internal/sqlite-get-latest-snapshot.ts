import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
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

const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

export function createSqliteGetLatestSnapshot<PE, PS>(
  connection: SqliteConnectionState,
  settings: Settings<PE, PS>,
  hooks?: SqliteEventStoreHooks,
): EventStore<PE, PS>["getLatestSnapshotById"] {
  return async (aggregateId) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    // 検証済みの ID なので、文字列の組み立てで失敗しない。
    const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;
    const usable = usableSqliteConnection(connection);
    if (usable.type === "err") return usable;
    const db = usable.value;

    let headRow: Readonly<Record<string, unknown>> | undefined;
    let currentRow: Readonly<Record<string, unknown>> | undefined;
    try {
      // SQ-8: ヘッドと snapshot_current を、1 つの明示的な読み取りトランザクションで読む。
      db.exec("BEGIN");
      try {
        const heads = db.prepare(
          "SELECT type_name, seq_nr FROM head WHERE aid = ?",
        );
        heads.setReadBigInts(true);
        headRow = heads.get(aid);
        hooks?.afterReadHead?.("snapshot");
        if (headRow !== undefined) {
          const currents = db.prepare(
            "SELECT seq_nr, manifest, payload FROM snapshot_current WHERE aid = ?",
          );
          currents.setReadBigInts(true);
          currentRow = currents.get(aid);
        }
      } finally {
        endSqliteTransaction(db);
      }
    } catch (cause) {
      return Result.err(
        EventStoreError.storage("snapshot query failed", cause),
      );
    }
    if (headRow === undefined) return Result.ok(undefined);
    if (headRow.type_name !== validatedId.value.typeName)
      return Result.err(EventStoreError.storage("invalid head type_name"));
    const headSeqNr = sqliteStoredInteger(
      headRow.seq_nr,
      "head seq_nr",
      BigInt(1),
      MAX_SEQ_NR,
    );
    if (headSeqNr.type === "err") return headSeqNr;
    if (currentRow === undefined)
      return Result.ok(Object.freeze({ headSeqNr: Number(headSeqNr.value) }));
    // R-8: 同じ読み取り時点なので、snapshot.seq_nr は head.seq_nr 以下になる。
    const seqNr = sqliteStoredInteger(
      currentRow.seq_nr,
      "snapshot seq_nr",
      BigInt(1),
      headSeqNr.value,
    );
    if (seqNr.type === "err") return seqNr;
    const manifest = currentRow.manifest;
    const bytes = currentRow.payload;
    if (typeof manifest !== "string" || !(bytes instanceof Uint8Array))
      return Result.err(
        EventStoreError.storage("invalid snapshot manifest or payload"),
      );
    try {
      const aggregate = settings.snapshotSerializer.deserialize(
        new Uint8Array(bytes),
        manifest,
      );
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
  };
}
