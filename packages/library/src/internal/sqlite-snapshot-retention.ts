import type { DatabaseSync } from "node:sqlite";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SqliteEventStoreHooks } from "./sqlite-event-store-hooks";
import { sqliteStoredInteger } from "./sqlite-stored-integer";
import { endSqliteTransaction } from "./sqlite-transaction";

const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 追記の確定後に、別の BEGIN IMMEDIATE で古い履歴だけを削除する（SQ-10・SQ-11）。
 * 新しい count 件を残し、今書いた番号も候補に加えて重複を除く。例外は投げず、失敗は結果で返す。
 */
export function retainSqliteSnapshots(
  db: DatabaseSync,
  aid: string,
  justWrittenSeqNr: number,
  count: number,
  hooks?: Pick<SqliteEventStoreHooks, "beforeRetentionDelete" | "listHistory">,
): Result<void, EventStoreError> {
  try {
    db.exec("BEGIN IMMEDIATE");
    const select = db.prepare(
      "SELECT seq_nr FROM snapshot_history WHERE aid = ? ORDER BY seq_nr DESC",
    );
    select.setReadBigInts(true);
    const stored: number[] = [];
    for (const row of select.all(aid)) {
      const seqNr = sqliteStoredInteger(
        row.seq_nr,
        "history seq_nr",
        BigInt(1),
        MAX_SEQ_NR,
      );
      if (seqNr.type === "err") {
        endSqliteTransaction(db);
        return seqNr;
      }
      stored.push(Number(seqNr.value));
    }
    const listed = hooks?.listHistory?.(aid, stored) ?? stored;
    const targets = [...new Set([...listed, justWrittenSeqNr])]
      .sort((a, b) => b - a)
      .slice(count)
      .sort((a, b) => a - b);
    const remove = db.prepare(
      "DELETE FROM snapshot_history WHERE aid = ? AND seq_nr = ?",
    );
    for (const seqNr of targets) {
      hooks?.beforeRetentionDelete?.(aid, seqNr);
      remove.run(aid, BigInt(seqNr));
    }
    db.exec("COMMIT");
    return Result.ok(undefined);
  } catch (cause) {
    endSqliteTransaction(db);
    return Result.err(
      EventStoreError.storage("snapshot retention failed", cause),
    );
  }
}
