/** 内部試験用。すべて同期で、トランザクションの途中に差し込む。 */
export type SqliteEventStoreHooks = Readonly<{
  /** 追記の BEGIN IMMEDIATE の中で、ヘッドを読んだ直後に呼ぶ。 */
  afterHeadRead?: () => void;
  /** COMMIT の直前に呼ぶ。投げると ROLLBACK して保存先エラーになる。 */
  beforeCommit?: () => void;
  /** 読み取りトランザクションの中で、ヘッドを読んだ直後に呼ぶ。読み取りの種類を渡す。 */
  afterReadHead?: (read: "events" | "snapshot") => void;
  /** 履歴の整理で、保存済みの履歴の一覧を読んだ直後に呼ぶ。返した一覧を整理の候補にする。 */
  listHistory?: (aid: string, seqNrs: readonly number[]) => readonly number[];
  /** 履歴の整理で行を削除する直前に呼ぶ。 */
  beforeRetentionDelete?: (aid: string, seqNr: number) => void;
}>;
