import type { EventStoreError } from "./event-store-error";
import type { SpannerMigrationRejection } from "./spanner-migration-rejection";
import type { SpannerMigrationReport } from "./spanner-migration-report";

type Progress = Pick<
  SpannerMigrationReport,
  "aggregates" | "events" | "snapshots"
>;

/**
 * 移行の失敗。
 * - `rejected`: 検査で拒んだ。移行先には何も書いていない。
 * - `error`: 保存先の失敗。`progress` は書き終えた件数。
 * - `verification-failed`: 書いた後の読み戻しが食い違った。
 */
export type SpannerMigrationFailure =
  | Readonly<{
      type: "rejected";
      rejections: readonly SpannerMigrationRejection[];
    }>
  | Readonly<{ type: "error"; error: EventStoreError; progress: Progress }>
  | Readonly<{
      type: "verification-failed";
      mismatches: readonly Readonly<{ aggregateId: string; reason: string }>[];
      progress: Progress;
    }>;
