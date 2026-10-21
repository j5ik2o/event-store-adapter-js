/** 移行の結果。`eventsOnlyAggregates` は、スナップショットを移さずイベントだけを移した v4 の aggregate_id。 */
export type SpannerMigrationReport = Readonly<{
  aggregates: number;
  events: number;
  snapshots: number;
  eventsOnlyAggregates: readonly string[];
}>;
