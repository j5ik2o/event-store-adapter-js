/** 内部試験用。実履歴の列挙と、各履歴の実削除直前だけを差し替える。 */
export type MemoryRetentionHooks = Readonly<{
  listHistory?: (
    aggregateId: string,
    seqNrs: readonly number[],
  ) => readonly number[] | Promise<readonly number[]>;
  beforeDelete?: (aggregateId: string, seqNr: number) => void | Promise<void>;
}>;
