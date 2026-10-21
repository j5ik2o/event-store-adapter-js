import type { Database } from "@google-cloud/spanner";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { spannerRows } from "./spanner-rows";

export type SpannerMigrationSource = Readonly<{
  journal: readonly Record<string, unknown>[];
  snapshots: readonly Record<string, unknown>[];
  /** 移行先のデータテーブルのうち、行が 1 つでもあるものの名前。 */
  populatedTargetTables: readonly string[];
}>;

/**
 * v4 の 2 テーブルの全件と、移行先のデータテーブルの有無を、1 つの strong の読み取り専用トランザクションで読む。
 * 検査と書き込みは、ここで読んだ同じデータだけを使う。テーブル名は呼び出し側で識別子として検査済み。
 */
export async function readSpannerMigrationSource(
  database: Database,
  v4Tables: Readonly<{ journal: string; snapshot: string }>,
  targetDataTables: readonly string[],
): Promise<Result<SpannerMigrationSource, EventStoreError>> {
  try {
    const [snapshot] = await database.getSnapshot({ strong: true });
    try {
      const journal = await spannerRows(
        snapshot,
        `SELECT shard_id, aggregate_id, sequence_number, payload, UNIX_MILLIS(occurred_at) AS occurred_at_ms, occurred_at = TIMESTAMP_TRUNC(occurred_at, MILLISECOND) AS millisecond_precision FROM \`${v4Tables.journal}\``,
      );
      const snapshots = await spannerRows(
        snapshot,
        `SELECT shard_id, aggregate_id, sequence_number, version, payload FROM \`${v4Tables.snapshot}\``,
      );
      const populated = await targetDataTables.reduce(
        async (previous, table) => {
          const names = await previous;
          const rows = await spannerRows(
            snapshot,
            `SELECT 1 AS found FROM \`${table}\` LIMIT 1`,
          );
          return rows.length > 0 ? [...names, table] : names;
        },
        Promise.resolve<readonly string[]>([]),
      );
      return Result.ok(
        Object.freeze({ journal, snapshots, populatedTargetTables: populated }),
      );
    } finally {
      snapshot.end();
    }
  } catch (cause) {
    return Result.err(
      EventStoreError.storage("v4 tables could not be read", cause),
    );
  }
}
