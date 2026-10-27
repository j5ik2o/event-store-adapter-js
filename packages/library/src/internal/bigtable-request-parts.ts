import type { BigtableMutation } from "./bigtable-mutation";
import type { BigtableRowFilter } from "./bigtable-row-filter";

export const FAMILY_EVENT = "event";
export const FAMILY_HISTORY = "history";
export const FAMILY_HEAD = "head";
export const FAMILY_SNAPSHOT = "snapshot";
export const FAMILY_CONFIG = "config";

export const EVENT_ENVELOPE = "envelope";
export const EVENT_HAS_SNAPSHOT = "has_snapshot";
export const HISTORY_STATE = "state";
export const HISTORY_ENVELOPE = "envelope";
export const HEAD_SEQ_NR = "seq_nr";
export const HEAD_LAST_EVENT = "last_event";
export const HEAD_HAS_SNAPSHOT = "has_snapshot";
export const SNAPSHOT_CURRENT = "current";
export const CONFIG_METADATA = "metadata";

export const STATE_ACTIVE = Buffer.from("active");
export const STATE_RETIRED = Buffer.from("retired");
export const FLAG_SET = Buffer.from("1");
export const FLAG_UNSET = Buffer.from("0");

/** 列ファミリと列修飾子が完全一致する列のセルだけを通す（両端を閉じた範囲）。 */
export const column = (
  family: string,
  qualifier: string,
): BigtableRowFilter => ({
  columnRangeFilter: {
    familyName: family,
    startQualifierClosed: Buffer.from(qualifier),
    endQualifierClosed: Buffer.from(qualifier),
  },
});

/** 列ごとに最新の 1 セルだけを通す（BT-2・BT-6）。 */
export const latestCell = (): BigtableRowFilter => ({
  cellsPerColumnLimitFilter: 1,
});

/** 値が完全一致するセルだけを通す（両端を閉じた範囲）。 */
export const valueEquals = (value: Uint8Array): BigtableRowFilter => ({
  valueRangeFilter: {
    startValueClosed: Buffer.from(value),
    endValueClosed: Buffer.from(value),
  },
});

/** 前から順にフィルターを適用する。 */
export const chain = (
  filters: readonly BigtableRowFilter[],
): BigtableRowFilter => ({ chain: { filters: [...filters] } });

/** 列にセルがあるときだけセルを通す（条件付き更新の条件）。 */
export const latestCellExists = (
  family: string,
  qualifier: string,
): BigtableRowFilter => chain([column(family, qualifier), latestCell()]);

/** 列の最新の 1 セルが expected のときだけセルを通す。過去の版には一致しない（BT-6）。 */
export const latestCellEquals = (
  family: string,
  qualifier: string,
  expected: Uint8Array,
): BigtableRowFilter =>
  chain([column(family, qualifier), latestCell(), valueEquals(expected)]);

/** セルを書く。セル時刻は常に 0 マイクロ秒にする（BT-6）。 */
export const setCell = (
  family: string,
  qualifier: string,
  value: Uint8Array,
): BigtableMutation => ({
  setCell: {
    familyName: family,
    columnQualifier: Buffer.from(qualifier),
    timestampMicros: 0,
    value: Buffer.from(value),
  },
});

/** 列の全ての版を削除する。 */
export const deleteColumn = (
  family: string,
  qualifier: string,
): BigtableMutation => ({
  deleteFromColumn: {
    familyName: family,
    columnQualifier: Buffer.from(qualifier),
  },
});

/** 列の全ての版を削除してから新しい値を書く。同じ原子的な操作の中に並べて使う（BT-6）。 */
export const replaceCell = (
  family: string,
  qualifier: string,
  value: Uint8Array,
): readonly BigtableMutation[] => [
  deleteColumn(family, qualifier),
  setCell(family, qualifier, value),
];
