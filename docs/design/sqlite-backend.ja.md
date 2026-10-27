> この文書は [sqlite-backend.md](sqlite-backend.md) の日本語版です。英語版が正本で、食い違うときは英語版に従います。

# SQLite の保存先の設計

この文書は、`event-store-adapter-js` の SQLite の保存先の設計記録です。現在の使い方は [README](../../packages/library/README.ja.md) と [スキーマ文書](../../packages/library/docs/SQLITE_DATABASE_SCHEMA.ja.md) を確認してください。

- 規範の出典: ハブ (j5ik2o/event-store-adapter) の `docs/spec/core-contract.md` と `docs/spec/storage/sqlite.md` (v5)。この文書は規則を追加せず、仕様も変えません。規則の番号 (SQ-1、W-8 など) は、これらの出典の番号です。
- 適合データ: `conformance/` (v1.3.0)。共通の 42 場面、SQLite 固有の 7 場面、共有の 1 場面を、すべて SQLite の保存先に対して実行します (`packages/library/src/internal/test/conformance/conformance-sqlite.test.ts`)。対象外はナノ秒精度の 4 場面だけです (`Date` はミリ秒精度)。必須の 68 ケースがすべて合格し、失敗・未検証・表現不能は 0 です。
- 以下のパスは `packages/library/src/` からの相対です。「試験」は、そのファイルの jest の試験を指します。

## 1. 決定

| 決定 | 選択 | 理由 |
|:--|:--|:--|
| ドライバー | Node.js 24.15 以上に同梱の `node:sqlite` (SQLite 3.51.3 以上。Node.js 24.22 では 3.53.4) | 依存もネイティブのビルドも要りません。`BigInt` の読み書きと `isTransaction` を使えます。 |
| 入口 | メインの入口とは別の `event-store-adapter-js/sqlite` | メインの入口が `node:sqlite` を読み込んではいけないためです (Spanner と同じ方式)。 |
| 接続の所有 | ライブラリが `path` を受け取り、ストアごとに接続を 1 本開き、`close()` を返す | URI としての解釈・共有キャッシュ・`ATTACH`・TEMP 表で、ライブラリが見る表の名前が変わるのを防ぎます。 |
| 初期化 | `SqliteEventStore.initialize` と `SqliteEventStore.create` を分ける (SQ-D6) | `create` は配置を作らず、補いません。 |
| トランザクション | すべて `await` を挟まず同期で行う | 1 本の接続を、途中で別の操作へ渡しません (SQ-5、SQ-17)。 |
| ヘッド | 操作のたびに読み、キャッシュしない | 別の接続や別のプロセスが確定している可能性があるためです。 |
| 保持の型 | 既存の `SnapshotRetention`。TTL は `configuration-error` | メモリの保存先と同じ型・同じ扱いです (SQ-11)。 |
| `aid` の照合順序 | 列の宣言の照合順序は `sqlite_schema.sql` を字句に分けて読み、主キーの索引は `pragma_index_xinfo` で読む。どちらも `BINARY` でなければならない | Node.js に列のメタデータを読む API がないためです。列が `NOCASE` で主キーの索引が `BINARY` だと、`User-A` と `User-a` を同じ集約として読むので、両方を確かめます。 |
| 対象外 | 変更フィード (SQ-12、SQ-13、SQ-18) は最初の版では提供しません (SQ-D8)。要求の分割 (ページ送り) は、SQLite の文がすべてローカルのファイルに対するものなので要りません。移行ツールは、旧版に SQLite の保存先がないので提供しません。 | |

## 2. 規則と試験の対応

| 規則 | 振る舞い | 試験 |
|:--|:--|:--|
| SQ-1、SQ-14、SQ-15 | 版の確認 (部分ごとの整数の比較)。`busy_timeout`・`locking_mode`・`journal_mode`・`synchronous`・`read_uncommitted` を設定して読み直す。`lockWaitMilliseconds` を省略すると既定の 5000 になる | `internal/sqlite-connection.test.ts`: `meetsMinimumSqliteVersion`、`openSqliteConnection`、`internal/sqlite-event-store-input-validation.test.ts`: "resolves an omitted lockWaitMilliseconds to the documented default 5000 (SQ-1)" |
| SQ-2、SQ-19 | 記録した設定とクライアントの設定を照合する。食い違いは `configuration-error` で、表と行は変えない。例外として、どの接続もファイルを開いた時点で、配置と設定を照合する前に `journal_mode = WAL` を設定する（SQ-1、SQ-14）ので、`journal_mode` が `wal` でなかったファイルは、拒否する場合も WAL に切り替わる | `internal/sqlite-store-configuration.test.ts`: "recorded configuration against the client (SQ-2, SQ-19)"、"opening a rejected file (SQ-1, SQ-14, SQ-2)"（表と行は変わらず、`journal_mode` が `delete` から `wal` に切り替わる）、適合 `sqlite-seeded-*` |
| SQ-2 (aid の照合順序) | 列と主キーの索引がどちらも `BINARY` でなければならない。誤設定のファイルは開くときに拒み、表と行は変更しない（上の行のとおり、`journal_mode` だけは WAL に切り替わることがある）。既定と明示の `BINARY` は受け入れる | `internal/sqlite-layout.test.ts`: "aid collation (SQ-2)"、`internal/sqlite-column-collation.test.ts` |
| SQ-3、SQ-4 | 整数は `BigInt` で結び付けて読む (`typeof` は integer・text・blob)。ナノ秒は負の無限大方向へ切り捨てる。`aid` は完全一致 (`User-A`・`User-a`・`Order-%`) | `internal/sqlite-event-store.test.ts`: "stored values (SQ-VALUES)" |
| SQ-5、SQ-17 | ヘッドの読み取りの前に `BEGIN IMMEDIATE`。1 本の接続で、`await` を挟まない | `internal/sqlite-event-store.test.ts`: "the head is read after BEGIN IMMEDIATE has taken the write lock (SQ-5, SQ-17)" |
| SQ-6 | `COMMIT` の前の失敗は ROLLBACK する。`COMMIT` の失敗は `storage-error` で、採番し直さない | `internal/sqlite-event-store.test.ts`: "a failure after the journal and head rows were written rolls everything back (SQ-6)"、"a failure just before COMMIT is a storage error…" |
| SQ-7 | busy と待ち時間の超過は `storage-error` で、楽観ロックの競合にはしない。待つ時間は `lockWaitMilliseconds` | `internal/sqlite-concurrency.test.ts`: "lock wait (SQ-7, SQ-1)"、適合 `sqlite-write-lock-busy` |
| W-8 (別のプロセス) | 別のプロセスが seq 2 を確定させるのを待った追記は `optimistic-lock-conflict` | `internal/sqlite-concurrency.test.ts`: "another process (W-8, SQ-5)" |
| SQ-8、SQ-9 | 最新のスナップショットとイベントを、それぞれ 1 つの読み取りトランザクションで読む。途中の確定は混ざらない | `internal/sqlite-event-store.test.ts`: "read (SQ-READ)" |
| SQ-10 | 確定の直後に、別の `BEGIN IMMEDIATE` で新しい n 件の履歴だけを残す | `internal/sqlite-snapshot-retention.test.ts`: "successful retention (SQ-10)" |
| SQ-11 | 整理の失敗は ROLLBACK し、loggerと `onRetentionFailure` へ通知する。通知の経路が例外を投げても reject しても、追記は成功のまま (試験は経路が呼ばれたことを確かめる)。TTL は `configuration-error` | `internal/sqlite-snapshot-retention.test.ts`: "retention failure (SQ-11, S-4)"、`internal/sqlite-event-store-input-validation.test.ts`、適合 `sqlite-ttl-unsupported` |
| SQ-16 | すべての表が `STRICT`。`STRICT` でない表や列の違いは `configuration-error` | `internal/sqlite-layout.test.ts`: `createSqliteTables`、`verifySqliteLayout` |
| SQ-20 | `changeFeed` の指定、または記録した `change_feed_enabled` が 1 なら `configuration-error`。`head_transition` は作らない | `internal/sqlite-event-store.test.ts`: "initialize and create"、適合 `sqlite-change-feed-unsupported`、`sqlite-seeded-change-feed-enabled` |
| SQ-D6 | `create` は初期化しない。`initialize` は、すでにオブジェクトがあるファイルを拒む | `internal/sqlite-event-store.test.ts`: "initialize and create (SQ-INIT, SQ-OPEN)" |
| SQ-12、SQ-13、SQ-18 | 変更フィード: 最初の版では提供しない (SQ-D8) | 対象外 |
| 形式の互換 | Rust の DDL と値の形で書いたファイルをこの保存先が読む。この保存先が書いた行も Rust の形になる。配置は pragma で見て一致する | `internal/sqlite-rust-layout.test.ts` |
| 入口 | `./sqlite` の export、メインの入口との分離、pack した成果物の型検査と実行 | `sqlite.test.ts`、`sqlite-package.test.ts`、`sqlite-entry-isolation.test.ts`、`packages/tests/e2e/sqlite-entry-isolation.test.cjs`、`packages/tests/e2e/external-consumption.test.cjs` |

## 3. 適合の実行

`pnpm --filter event-store-adapter-js run coverage --runInBand` は、`coverage/conformance` (または `CONFORMANCE_REPORT_DIR`) に、メモリ・DynamoDB・Spanner のレポートと並べて `sqlite.json` を書きます。必須のケースが実行されない、失敗する、未検証になる、表現できないときは、`conformance-sqlite.test.ts` が失敗します。ケースごとに一時ファイルで実行し、終わったら削除します。外部のサービスには接続しません。
