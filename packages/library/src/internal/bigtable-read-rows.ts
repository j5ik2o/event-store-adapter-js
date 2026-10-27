import { EventStoreError } from "../event-store-error";
import { isEventStoreError } from "./bigtable-event-store-error-guard";
import type { BigtableReadRowsResponse } from "./bigtable-read-rows-response";
import type { BigtableRow } from "./bigtable-row";
import { RowCollector } from "./bigtable-row-collector";

/** 範囲の読み取りの流れを開く。resumeAfter があれば、そのキーの次の行から読む。 */
export type ReadRowsOpener = (
  resumeAfter?: Uint8Array,
) => AsyncIterable<BigtableReadRowsResponse>;

/**
 * 範囲の行を、行キーの順に全て読む。流れが途中で終わったら、最後に完成した行の次から再開する（BT-10）。
 * 前回の再開から 1 行も完成していなければ、同じ要求を繰り返さず、流れを止めた原因を保存先エラーにする。
 */
export async function readRows(
  open: ReadRowsOpener,
): Promise<readonly BigtableRow[]> {
  let rows: readonly BigtableRow[] = [];
  let resumeAfter: Uint8Array | undefined;
  for (;;) {
    const collector = new RowCollector();
    const completed: BigtableRow[] = [];
    try {
      for await (const response of open(resumeAfter)) {
        for (const chunk of response.chunks ?? []) {
          const row = collector.push(chunk);
          if (row !== undefined) completed.push(row);
        }
      }
    } catch (cause) {
      // 組み立ての矛盾は再開しても直らない。
      if (isEventStoreError(cause)) throw cause;
      const last = completed[completed.length - 1];
      if (last === undefined)
        throw EventStoreError.storage(
          "the read was interrupted without completing any row",
          cause,
        );
      rows = [...rows, ...completed];
      resumeAfter = last.key;
      continue;
    }
    if (collector.hasPartialRow())
      throw EventStoreError.storage("the read finished in the middle of a row");
    return [...rows, ...completed];
  }
}
