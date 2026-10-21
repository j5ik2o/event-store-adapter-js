import type { SpannerMigrationSnapshotRow } from "./spanner-migration-snapshot-row";

/** 1 つの集約の v4 の snapshot の行。`latest` は sequence_number = 0 の行、`retained` は 0 より大きい保持の写し。 */
export type SpannerMigrationSnapshotRows = Readonly<{
  aggregateId: string;
  /** その集約の journal の sequence_number の最大値。 */
  maxSeqNr: number;
  latest: readonly SpannerMigrationSnapshotRow[];
  retained: readonly SpannerMigrationSnapshotRow[];
}>;
