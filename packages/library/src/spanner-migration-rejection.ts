/** 移行を拒む理由の 1 件。 */
export type SpannerMigrationRejection = Readonly<{
  table: string;
  aggregateId?: string;
  shardId?: string;
  sequenceNumber?: number;
  reason: string;
}>;
