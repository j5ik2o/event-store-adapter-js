import type { Snapshot } from "@google-cloud/spanner";
import type { EventStoreError } from "../event-store-error";
import type { Result } from "../result";
import type { SpannerEventStoreHooks } from "./spanner-event-store-hooks";
import type {
  SpannerRetentionSettings,
  validateSpannerEventStoreInput,
} from "./spanner-event-store-input-validation";
import { runSpannerReadWriteTransaction } from "./spanner-read-write-transaction";
import { spannerRows } from "./spanner-rows";
import { spannerStoredInteger } from "./spanner-stored-integer";
import { SpannerTransactionRejection } from "./spanner-transaction-rejection";

type Settings = Readonly<
  Pick<
    Extract<
      ReturnType<typeof validateSpannerEventStoreInput<unknown, unknown>>,
      { type: "ok" }
    >["value"],
    "database" | "tables" | "transactionRetryLimit"
  > & { retention: SpannerRetentionSettings }
>;

const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 追記の確定後に、別の SERIALIZABLE トランザクションで古い履歴を整理する（SPN-11・SPN-12）。
 * 印のある行は数えず、再実行のたびに候補を選び直す。
 */
export function retainSpannerSnapshots(
  settings: Settings,
  key: Readonly<{ hashPrefix: Buffer; aid: string }>,
  hooks?: Pick<SpannerEventStoreHooks, "listHistory" | "beforeRetentionDelete">,
): Promise<Result<void, EventStoreError>> {
  const { database, tables, retention } = settings;
  const params = { hp: key.hashPrefix, aid: key.aid };
  const types = { hp: "bytes", aid: "string" };
  return runSpannerReadWriteTransaction(
    database,
    settings.transactionRetryLimit,
    async (transaction) => {
      const rows = await spannerRows(
        transaction as Snapshot,
        `SELECT seq_nr FROM \`${tables.snapshotHistory}\` WHERE hash_prefix = @hp AND aid = @aid AND expired_at IS NULL ORDER BY seq_nr DESC`,
        params,
        types,
      );
      const stored: number[] = [];
      for (const row of rows) {
        const seqNr = spannerStoredInteger(
          row.seq_nr,
          "history seq_nr",
          BigInt(1),
          MAX_SEQ_NR,
        );
        if (seqNr.type === "err")
          throw new SpannerTransactionRejection(seqNr.error);
        stored.push(Number(seqNr.value));
      }
      const listed =
        hooks?.listHistory === undefined
          ? stored
          : await hooks.listHistory(key.aid, stored);
      const targets = [...new Set(listed)]
        .sort((a, b) => b - a)
        .slice(retention.count)
        .sort((a, b) => a - b);
      if (targets.length === 0) return;
      for (const seqNr of targets)
        await hooks?.beforeRetentionDelete?.(key.aid, seqNr);
      const seqs = targets.map((seqNr) => seqNr.toString());
      const sql =
        retention.mode.type === "delete"
          ? `DELETE FROM \`${tables.snapshotHistory}\` WHERE hash_prefix = @hp AND aid = @aid AND seq_nr IN UNNEST(@seqs)`
          : `UPDATE \`${tables.snapshotHistory}\` SET expired_at = CURRENT_TIMESTAMP() WHERE hash_prefix = @hp AND aid = @aid AND seq_nr IN UNNEST(@seqs) AND expired_at IS NULL`;
      await transaction.runUpdate({
        sql,
        params: { ...params, seqs },
        types: { ...types, seqs: { type: "array", child: "int64" } },
      } as never);
    },
  );
}
