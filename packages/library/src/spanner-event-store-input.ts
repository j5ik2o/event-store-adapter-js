import type { Database } from "@google-cloud/spanner";
import type { Logger } from "./logger";
import type { PayloadSerializer } from "./payload-serializer";
import type { RetentionFailure } from "./retention-failure";
import type { SpannerSnapshotRetention } from "./spanner-snapshot-retention";

export type SpannerEventStoreInput<PE, PS> = Readonly<{
  database: Database;
  tablePrefix: string;
  eventSerializer?: PayloadSerializer<PE>;
  snapshotSerializer?: PayloadSerializer<PS>;
  retention?: SpannerSnapshotRetention;
  /** 最初の版は変更フィードを提供しない。値を指定すると設定エラーになる。 */
  changeFeed?: unknown;
  /** ABORTED の再実行の上限。初回は数えない。既定は 5。 */
  transactionRetryLimit?: number;
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
}>;
