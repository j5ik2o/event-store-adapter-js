import type { Bigtable } from "@google-cloud/bigtable";
import type { BigtableJournalWriteFailure } from "./bigtable-journal-write-failure";
import type { Logger } from "./logger";
import type { PayloadSerializer } from "./payload-serializer";
import type { RetentionFailure } from "./retention-failure";
import type { SnapshotRetention } from "./snapshot-retention";

export type BigtableEventStoreInput<PE, PS> = Readonly<{
  /** 呼び出し側が所有し、閉じるクライアント。 */
  bigtable: Bigtable;
  instanceId: string;
  /** 事前に列ファミリ付きで作る 2 つのテーブルの ID。同じ ID は指定できない。 */
  tables: Readonly<{ journal: string; head: string }>;
  /** 1 つの封筒の最大バイト数。17 から 8388608 の整数で、既定は 1048576。 */
  envelopeLimitBytes?: number;
  eventSerializer?: PayloadSerializer<PE>;
  snapshotSerializer?: PayloadSerializer<PS>;
  /** 履歴に残すスナップショットの件数。TTL は提供しない。指定すると設定エラーになる。 */
  retention?: SnapshotRetention;
  /** 最初の版は変更フィードを提供しない。値を指定すると設定エラーになる。 */
  changeFeed?: unknown;
  /** すべての要求の直前に 1 回呼び、`authorization: Bearer` に付ける。保持と更新は呼び出し側の責任。 */
  accessToken?: () => string | Promise<string>;
  onRetentionFailure?: (failure: RetentionFailure) => void;
  /** 確定後の末尾の書き出しの失敗を知らせる。追記は成功のまま。 */
  onJournalWriteFailure?: (failure: BigtableJournalWriteFailure) => void;
  logger?: Logger;
}>;
