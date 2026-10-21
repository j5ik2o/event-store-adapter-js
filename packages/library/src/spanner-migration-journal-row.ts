/** v4 の journal の 1 行。`shardId` は INT64 を 10 進文字列にしたもの。 */
export type SpannerMigrationJournalRow = Readonly<{
  aggregateId: string;
  shardId: string;
  sequenceNumber: number;
  payload: Uint8Array;
  /** v4 の TIMESTAMP（ミリ秒の精度）を Date にしたもの。 */
  occurredAt: Date;
}>;
