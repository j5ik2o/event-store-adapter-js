import type { Database } from "@google-cloud/spanner";
import type { Result } from "./result";
import type { SnapshotEnvelope } from "./snapshot-envelope";
import type { SpannerEventStoreInput } from "./spanner-event-store-input";
import type { SpannerMigrationJournalRow } from "./spanner-migration-journal-row";
import type { SpannerMigrationRestoredEvent } from "./spanner-migration-restored-event";
import type { SpannerMigrationSnapshotRows } from "./spanner-migration-snapshot-rows";

export type SpannerMigrationInput<PE = unknown, PS = unknown> = Readonly<{
  database: Database;
  v4Tables: Readonly<{ journal: string; snapshot: string }>;
  /** 移行先。`SpannerEventStore.create` に渡す入力から `database` を除いたもの。 */
  target: Omit<SpannerEventStoreInput<PE, PS>, "database">;
  /** 旧型名に `-` があるときに引く、新しい型名への対応表。 */
  typeNameMapping?: ReadonlyMap<string, string>;
  /** v4 の journal の 1 行から型名・値・manifest・payload を復元する。復元できなければ理由を返す。 */
  restoreEvent: (
    row: SpannerMigrationJournalRow,
  ) => Result<SpannerMigrationRestoredEvent<PE>, string>;
  /** 集約ごとの v5 のスナップショットを返す。`undefined` は「移さない」。 */
  restoreSnapshot?: (
    rows: SpannerMigrationSnapshotRows,
  ) => SnapshotEnvelope<PS> | undefined;
}>;
