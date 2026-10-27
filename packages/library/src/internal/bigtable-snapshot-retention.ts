import { EventStoreError } from "../event-store-error";
import {
  chain,
  column,
  deleteColumn,
  FAMILY_HISTORY,
  HISTORY_ENVELOPE,
  HISTORY_STATE,
  latestCell,
  latestCellEquals,
  replaceCell,
  STATE_ACTIVE,
  STATE_RETIRED,
} from "./bigtable-request-parts";
import { cellValue } from "./bigtable-row";
import { journalRange, journalRowKey, journalSeqNr } from "./bigtable-row-keys";
import type { BigtableStoreResources } from "./bigtable-store-resources";

const same = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** 新しい keep 件を残し、それより古い履歴を選ぶ。just は今書いた履歴で、まだ journal にないことがある。 */
function selectExpired(
  visible: readonly number[],
  just: number,
  keep: number,
): readonly number[] {
  const all = visible.includes(just) ? [...visible] : [...visible, just];
  return [...new Set(all)].sort((a, b) => b - a).slice(keep);
}

/**
 * 履歴を整理する（BT-11・BT-12・BT-13）。h は追記で確定した seq_nr である。
 * journal の 1〜h で active な履歴の状態だけを読み、新しい keep 件より古い行だけを retired にする。
 * retired にするとき履歴の封筒を削除し、event のセルは残す。失敗は呼び出し側が通知する。
 */
export async function retainBigtableHistory<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
  aid: string,
  prefix: Uint8Array,
  h: number,
  keep: number,
): Promise<void> {
  const [start, end] = journalRange(prefix, 1, h + 1);
  const rows = await resources.journal.readRange(
    start,
    end,
    chain([column(FAMILY_HISTORY, HISTORY_STATE), latestCell()]),
  );
  const history = rows.map((row) => {
    const seqNr = journalSeqNr(prefix, row.key);
    if (seqNr === undefined)
      throw EventStoreError.storage("a journal row key does not hold a seq_nr");
    const state = cellValue(row, FAMILY_HISTORY, HISTORY_STATE);
    if (same(state, STATE_ACTIVE)) return { seqNr, active: true };
    if (same(state, STATE_RETIRED)) return { seqNr, active: false };
    throw EventStoreError.storage(
      "a journal row holds an unknown history state",
    );
  });
  const read = history
    .filter((entry) => entry.active)
    .map((entry) => entry.seqNr);
  const visible = (await resources.hooks?.listHistory?.(aid, read)) ?? read;
  const expired = selectExpired(visible, h, keep);
  if (expired.length === 0) return;
  await resources.hooks?.beforeRetentionDelete?.(aid, expired);
  for (const seqNr of expired) {
    // active の行だけを、履歴の封筒を削除して retired にする。retired の行には何もしない（BT-12）。
    await resources.journal.checkAndMutate(
      journalRowKey(prefix, seqNr),
      latestCellEquals(FAMILY_HISTORY, HISTORY_STATE, STATE_ACTIVE),
      [
        deleteColumn(FAMILY_HISTORY, HISTORY_ENVELOPE),
        ...replaceCell(FAMILY_HISTORY, HISTORY_STATE, STATE_RETIRED),
      ],
      [],
    );
  }
}
