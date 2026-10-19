/** 内部試験用。確定の前後・読み取り前・履歴の列挙と削除前だけを差し込む。 */
export type SpannerEventStoreHooks = Readonly<{
  beforeCommit?: () => void | Promise<void>;
  /** コミットが成功した後に呼ぶ。投げると成否不明の保存先エラーになる（SPN-8）。 */
  afterCommit?: () => void | Promise<void>;
  beforeReadEvents?: () => void | Promise<void>;
  beforeReadSnapshot?: () => void | Promise<void>;
  listHistory?: (
    aggregateId: string,
    seqNrs: readonly number[],
  ) => readonly number[] | Promise<readonly number[]>;
  beforeRetentionDelete?: (
    aggregateId: string,
    seqNr: number,
  ) => void | Promise<void>;
}>;
