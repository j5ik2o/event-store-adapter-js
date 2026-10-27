> この文書は [SQLITE_DATABASE_SCHEMA.md](SQLITE_DATABASE_SCHEMA.md) の日本語版です。英語版が正本で、食い違うときは英語版に従います。

# SQLite の保存先のスキーマ

## 配置

この文書は、`event-store-adapter-js/sqlite` の入口にある `SqliteEventStore.initialize(...)` が作り、`SqliteEventStore.create(...)` が開くファイルを説明します。使い方は [現在の README](../README.ja.md) を参照してください。配置は Rust 版と同じなので、どちらの実装が作ったファイルも、もう一方で読み書きできます。

1 つのローカルのデータベースファイルに 5 つのテーブルを置きます。すべて `STRICT` なので、宣言した型に変換できない値はデータベースが拒みます。`aid` を持つテーブルでは、`aid` は `TEXT COLLATE BINARY` で、主キーの索引も `BINARY` の照合順序でなければなりません。列や主キーの索引が `NOCASE` や `RTRIM` のファイルは、`User-A` と `User-a` を同じ集約として読んでしまうので、開くときに拒みます。この版は変更フィードを提供しないので、`head_transition` テーブルはありません。

| テーブル | 主キー | そのほかの列 |
|:--|:--|:--|
| `journal` | `(aid, seq_nr)` | `occurred_at_ns INTEGER`、`manifest TEXT`、`payload BLOB` |
| `head` | `aid` | `type_name TEXT`、`seq_nr INTEGER`、`event_occurred_at_ns INTEGER`、`event_manifest TEXT`、`event_payload BLOB` |
| `snapshot_current` | `aid` | `seq_nr INTEGER`、`manifest TEXT`、`payload BLOB` |
| `snapshot_history` | `(aid, seq_nr)` | `manifest TEXT`、`payload BLOB` |
| `config` | `singleton` | `store_id TEXT`、`layout_version INTEGER`、`keep_snapshot_count INTEGER`、`retention_mode TEXT`、`change_feed_enabled INTEGER` |

`seq_nr` は `INTEGER NOT NULL` で、`CHECK (seq_nr BETWEEN 1 AND 9007199254740991)` を持ちます。`aid` は `<typeName>-<value>` で、比較は常に完全一致です。`LIKE` は使いません。

## 設定

`config` テーブルには、ちょうど 1 行 (`singleton = 1`) を置きます。

| 列 | 値 |
|:--|:--|
| `store_id` | 小文字の UUID。`initialize` が生成します |
| `layout_version` | `1` |
| `keep_snapshot_count` | クライアントの `retention.count`。保持を指定しないときは `NULL` |
| `retention_mode` | `delete` |
| `change_feed_enabled` | `0` |

`create` は、この行とクライアントの設定を 1 つの読み取りトランザクションの中で照合します。保持件数・配置の版・保持方式の違い、`change_feed_enabled` が `1`、`store_id` の形の誤り、行の欠落は、いずれも `configuration-error` です。`create` は欠けた定義を補いません。

接続のたびに、同梱の SQLite が 3.51.3 以上であること（部分ごとに整数として比べます）を確かめ、`busy_timeout`（`lockWaitMilliseconds`、既定 5000）、`locking_mode = normal`、`journal_mode = wal`、`synchronous = 2`（FULL）、`read_uncommitted = 0` を設定して読み直します。

## 初期化

`SqliteEventStore.initialize({ path, retention? })` は、空のファイルを 1 つの `BEGIN IMMEDIATE` トランザクションの中で初期化します。5 つのテーブルと `config` の行を作ります。テーブル・索引・ビュー・トリガーが 1 つでもあるファイルは `configuration-error` で、何も作りません。`create` はファイルを初期化せず、ファイルが無ければ作らずに `storage-error` にします。TTL の保持と `changeFeed` の指定は、ファイルを開く前に `configuration-error` になります。

```typescript
import { SqliteEventStore } from "event-store-adapter-js/sqlite";

const input = { path: "/var/lib/app/events.sqlite3", retention: { count: 3 } };
const initialized = await SqliteEventStore.initialize(input);
const opened = await SqliteEventStore.create(input);
```

## 記録

- `journal` はすべてのイベントを持ちます。`head` は最新のイベントの番号・時刻・manifest・payload と `type_name` を持ちます。
- `snapshot_current` は最新のスナップショットを持ちます。`snapshot_history` は、`keep_snapshot_count` を設定したときだけ書きます。このとき最新のスナップショットも `snapshot_current` と `snapshot_history` の両方に保存し、残す `count` 件に数えます。
- 整数は `BigInt` で結び付けて読み、保存クラスは `integer` です。`manifest` は `text`、`payload` は `blob` です。
- `occurred_at_ns` は、ミリ秒の時刻に 1,000,000 を掛けた値です。読むときは、負の無限大方向へ切り捨ててミリ秒にします（-1 ns は -1 ms）。

## 書き込みと読み取り

追記は、先に検査と直列化を済ませ、ストアの 1 本の接続の上で、途中で制御を手放さずに行います。`BEGIN IMMEDIATE`、ヘッドの読み取り、照合、`journal`・`head`・`snapshot_current`・`snapshot_history` への書き込み、`COMMIT` の順です。`COMMIT` の前の失敗は ROLLBACK し、何も見えません。

- ヘッド以下の番号は、主キーの重複を含め、ヘッドの番号を持つ `optimistic-lock-conflict` です。飛び番は `contract-violation`（W-8）、スナップショットの番号がイベントと違う場合は W-9 です。
- 別の接続の書き込みロックを `lockWaitMilliseconds` より長く待つと `storage-error` で、楽観ロックの競合にはなりません。`COMMIT` の失敗は `storage-error` で、ライブラリは採番し直しません。
- 最新のスナップショットの読み取りは、`head` と `snapshot_current` を 1 つの読み取りトランザクションで読みます。イベントの読み取りは、`head` を読んでから、ヘッドまでの `journal` を同じ読み取りトランザクションで読みます。途中で別の接続が確定しても、混ざりません。ヘッド以下の番号が欠けていれば `storage-error` です。

## 保持

ストアが `retention: { count }` を持つとき、スナップショット付きの追記は `snapshot_history` にも書きます。`COMMIT` の直後に、別の `BEGIN IMMEDIATE` トランザクションで、その集約の新しい `count` 件（今書いたものを含む）だけを残し、古いものを削除します。`snapshot_current`・`head`・`journal` は削除しません。

この整理が失敗したら ROLLBACK し、loggerと `onRetentionFailure` へ通知します。通知の経路が例外を投げても reject しても、追記の成功は変わりません。次のスナップショット付きの追記で、整理をやり直します。TTL の保持は提供せず、`configuration-error` になります。

## 運用

- プロセスを終える前に `close()` でストアを閉じます。`close()` は何度呼んでも安全で、閉じた後の操作は `storage-error` です。
- 同じホストの複数のストアと複数のプロセスが、1 つのファイルを開けます。追記は SQLite の書き込みロックで直列になり、番号で照合します。
- ファイルをネットワークファイルシステムに置かないでください。`file:` の URI・共有キャッシュ・`ATTACH` でも開かないでください。ライブラリは `path` を絶対パスのファイル名にして、自分で開きます。
- 保持件数を変えるには、すべてのクライアントを止めて、外部の手順で `keep_snapshot_count` を変えます。件数の違うクライアントは拒まれます。
