/** v4 の snapshot の 1 行。`version` は参考用で、v5 には移されない。 */
export type SpannerMigrationSnapshotRow = Readonly<{
  shardId: string;
  sequenceNumber: number;
  version: string;
  payload: Uint8Array;
}>;
