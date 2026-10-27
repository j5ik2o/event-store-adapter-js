/** 追記の確定後に、新しい末尾を journal へ書き出せなかったことを知らせる。追記そのものは確定している。 */
export type BigtableJournalWriteFailure = Readonly<{
  kind: "journal-write-failure";
  aggregateId: string;
  seqNr: number;
  cause: unknown;
}>;
