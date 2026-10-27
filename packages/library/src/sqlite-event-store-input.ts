import type { Logger } from "./logger";
import type { PayloadSerializer } from "./payload-serializer";
import type { RetentionFailure } from "./retention-failure";
import type { SnapshotRetention } from "./snapshot-retention";

export type SqliteEventStoreInput<PE, PS> = Readonly<{
  /** ローカルの SQLite ファイルのパス。URI としては解釈されない。 */
  path: string;
  eventSerializer?: PayloadSerializer<PE>;
  snapshotSerializer?: PayloadSerializer<PS>;
  /** 履歴に残すスナップショットの件数。TTL は提供しない。指定すると設定エラーになる。 */
  retention?: SnapshotRetention;
  /** 最初の版は変更フィードを提供しない。値を指定すると設定エラーになる。 */
  changeFeed?: unknown;
  /** 別の接続の書き込みロックを待つ時間（ミリ秒）。0 から 2147483647 の整数で、既定は 5000。
   * node:sqlite は同期 API なので、待つあいだはスレッドを占有しイベントループが止まる。サーバーでは短い値にする。 */
  lockWaitMilliseconds?: number;
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
}>;
