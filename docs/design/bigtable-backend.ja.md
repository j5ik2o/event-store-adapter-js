> この文書は [bigtable-backend.md](bigtable-backend.md) の日本語版です。英語版が正本で、食い違うときは英語版に従います。

# Bigtable の保存先の設計

この文書は、`event-store-adapter-js` の Bigtable の保存先の設計記録です。現在の使い方は [README](../../packages/library/README.ja.md) と [スキーマ文書](../../packages/library/docs/BIGTABLE_DATABASE_SCHEMA.ja.md) を確認してください。

- 規範: ハブ（j5ik2o/event-store-adapter）の `docs/spec/core-contract.md` と `docs/spec/storage/bigtable.md`（v5）、およびそれらが引くハッシュの仕様と ADR。この文書は規則を足さず、仕様を変えません。規則の番号（BT-7、W-8 など）は、それらの番号です。
- 適合データ: `conformance/`（v1.3.0）。共通の 42 場面、Bigtable 固有の 12 場面、共有の 1 場面をすべて Bigtable の保存先で実行します。値の表（FNV-1a 64 の参照 4 件と封筒の 10 件）も実行します（`packages/library/src/internal/test/conformance/conformance-bigtable.test.ts`）。除外は `Date`（ミリ秒精度）で表せない 8 件だけです。`scenarios/core/write-read.json` の `core-time-*` の 4 場面と、`values/occurred-at.json` の `occurred-at-*` の 4 件です。必須の 87 件が合格し、失敗・未検証・表せないケースはありません。レポートは `coverage/conformance/bigtable.json` に保存します。
- 以下のパスは `packages/library/src/` からの相対パスです。「試験」は、そのファイルの jest の試験です。「エミュレーター」と付けた試験は、Testcontainers が起動する Cloud Bigtable エミュレーター（固定した `google-cloud-cli` のイメージ）に対して実行します。実サービスへは接続せず、実際の認証情報も使いません。

## 1. 決定

| 決定 | 選択 | 理由 |
|:--|:--|:--|
| SDK | `@google-cloud/bigtable` `^7.5.0`。省略可能な peer 依存で、`Bigtable#request` だけを通して使う | 規則は、要求の形（列の範囲のフィルター、最新のセル、時刻 0、条件付き更新）、分割された行の組み立てと再開を固定します。高水準の `Table`・`Row` の API はそれらをすべて隠します。`request` は、データと管理のすべての要求を観測できる唯一の場所でもあります。 |
| 入口 | `event-store-adapter-js/bigtable`。主な入口とは別 | 主な入口は Bigtable の SDK を読み込んではいけません（Spanner・SQLite と同じ方針）。入口自体は呼び出し側が渡すクライアントだけを使うので、SDK を実行時に import する必要がありません。 |
| クライアントの所有 | `Bigtable` クライアントは呼び出し側が作り、閉じる | ライブラリはテーブル・列ファミリ・クライアントを作りません。 |
| 初期化 | `BigtableEventStore.initialize` と `create` は別（BT-D1）。`initialize` は先に列ファミリを確かめる | `create` はテーブルも行も作らず、補いません。 |
| 確定点 | head の行への 1 回の `CheckAndMutateRow`。1 回だけ送り、再送しない | 応答を失うと結果は不明です（BT-7）。再送すると確定済みの head を読んで楽観ロックの失敗になります。 |
| 認証 | 省略可能な `accessToken` 関数を、データと管理のすべての要求の直前に 1 回呼ぶ | エミュレーターでは SDK が認証を付けないので、トークンの経路が呼ばれないまま試験が合格してしまいます。トークンは保持せず、エラーメッセージにも入れません。 |
| journal の書き出しの失敗 | `onJournalWriteFailure` と `BigtableJournalWriteFailure`（種類は `journal-write-failure`） | 適合データがこの通知を観測します。`RetentionFailure` を広げると共有の型の契約を壊します。 |
| 保持の型 | 既存の `SnapshotRetention`。TTL は `configuration-error` | メモリ・SQLite と同じ型です（BT-D4、BT-13）。 |
| 契約の規則 | `ContractRule` に `"BT-16"` を加える | 封筒の上限を超えたときに、その規則を報告します（BT-16、BT-D6b）。 |
| 除外 | 変更フィード（BT-14、BT-15、設定エラー以外の BT-17）は最初の版では提供しません（BT-D8）。旧版に Bigtable の保存先はないので、移行ツールは提供しません。 | |

## 2. 規則と試験の対応

| 規則 | 振る舞い | 試験 |
|:--|:--|:--|
| BT-1 | すべての要求に、クライアントの app profile（なければ `""`）と完全なテーブル名を付ける | `internal/bigtable-requests.test.ts`: "app profile and table name" |
| BT-2 | `create` と `initialize` で列ファミリを確かめる。ファミリの欠け・テーブルがない・規則がない・年齢による規則・2 版の規則は `configuration-error` | `internal/bigtable-store-configuration.test.ts`: "verifyBigtableStore"; `internal/bigtable-event-store.test.ts`（エミュレーター）: "create and initialize" |
| BT-3 | 行キー `H ‖ L16 ‖ A`。ハッシュが衝突しても別の ID は混ざらず、設定行 `0x00` はどの範囲にも入らない | `internal/bigtable-row-keys.test.ts`; `internal/bigtable-event-store.test.ts`（エミュレーター）: "hash collisions" |
| BT-4 | journal のキーは 8 バイトのビッグエンディアンの番号で終わる。バイトの順は数値の順で、範囲は固定幅の番号を使う | `internal/bigtable-row-keys.test.ts` |
| BT-5、BT-12 | journal の行は `event:envelope` がないときだけ作る。既存の行は照合し、上書きしない。遅れた書き手は retired の履歴を復活させない | `internal/bigtable-stored-rows.test.ts`: "writeJournalRow"; `internal/bigtable-event-store.test.ts`（エミュレーター）: "a stale writer that writes a retired history row later cannot revive the history" |
| BT-6 | セルは時刻 0 で書き、置き換える列は先に全版を削除し、条件は最新のセルだけを見る | `internal/bigtable-event-store.test.ts`（エミュレーター）: "cell layout and versions" |
| BT-7、H-1 | 順序は、検査と直列化、head の読み取り、W-3/W-8 の照合、直前のイベントの書き出し、head の条件付き更新、新しい末尾の書き出し。条件付き更新の不成立は楽観ロック。応答を失ったら保存先エラーで、再送しない | `internal/bigtable-faults.test.ts`（エミュレーター）: "failures before and at the commit point"; 適合 `bigtable-previous-event-write-failure`・`bigtable-new-tail-write-failure`・`bigtable-cas-response-lost` |
| BT-8、BT-9 | 最新のスナップショットは head の 1 回の読み取りから得る。イベントは最初に読んだ head の `h` を呼び出しの間ずっと使う。journal の範囲の欠番は保存先エラー | `internal/bigtable-read-operations.test.ts`; `internal/bigtable-event-store.test.ts`（エミュレーター）: "append and read" |
| BT-10 | 値の分割・同じ行キーの継続・`ResetRow` を組み立てる。途中で切れたら最後に完成した行の次から再開し、進まない場合や未完成の行は保存先エラー | `internal/bigtable-row-collector.test.ts`; `internal/bigtable-read-rows.test.ts`; `internal/bigtable-requests.test.ts`: "range reads" |
| BT-11、BT-12、BT-13 | 保持は行 `1..h` の履歴の状態だけを読み、新しい `n` 件より古い active な履歴を retired にし、event のセルは残す。失敗は追記を変えずに通知する | `internal/bigtable-event-store.test.ts`（エミュレーター）: "snapshot retention"; `internal/bigtable-stored-rows.test.ts`: "retainBigtableHistory"; `internal/bigtable-faults.test.ts`（エミュレーター）: "notifications never change a committed append" |
| BT-13、S-4 | 通知先（logger・`onRetentionFailure`・`onJournalWriteFailure`）が投げても拒否しても、確定済みの追記は変わらない。試験は、経路が呼ばれたことと保存済みのデータがあることを assert する | `internal/bigtable-faults.test.ts`（エミュレーター）; `internal/bigtable-journal-write-failure-notification.test.ts` |
| BT-16、BT-D6b | 上限を超える封筒は、書き込みの前に規則 `BT-16` の `contract-violation` にする。上限は両テーブルに記録し、不一致は `configuration-error`。範囲は 17 から 8388608 | `internal/bigtable-event-store.test.ts`（エミュレーター）: "envelope limit (BT-16)"・"input rejected before anything is written"; `internal/bigtable-event-store-input-validation.test.ts`; 適合 `bigtable-envelope-over-limit`・`bigtable-envelope-limit-*`・`bigtable-seeded-*` |
| BT-17 | `changeFeed` の指定は、要求の前に `configuration-error` | `internal/bigtable-event-store-input-validation.test.ts`; 適合 `bigtable-change-feed-unsupported` |
| BT-D1 | `create` は初期化しない。`initialize` は設定行がすでにあるテーブルを拒否する。設定 JSON は最上位のキーが一意で、`keep_snapshot_count` は厳密 | `internal/bigtable-configuration.test.ts`; `internal/bigtable-store-configuration.test.ts`; `internal/bigtable-event-store.test.ts`（エミュレーター）: "create and initialize" |
| BT-D6a | 封筒は固定のバイナリ形式。参照の 10 件と一致し、末尾の余り・長さの不一致・未知の版は保存先エラー | `internal/bigtable-envelope.test.ts`; 適合 `bigtable-envelope-*` |
| 認証 | データと管理のすべての要求がトークンの取得元を 1 回呼び、`authorization: Bearer` を付ける。失敗したトークンや ASCII でないトークンは送らない | `internal/bigtable-access-token.test.ts`（エミュレーター）; `internal/bigtable-requests.test.ts` |
| 形式の互換 | Rust の形で書いた行をこの保存先が読み、この保存先が書いた行は Rust のキー・セル名・封筒のバイトを持つ | `internal/bigtable-rust-layout.test.ts`（エミュレーター） |
| 入口 | `./bigtable` の export、省略可能な peer 依存、ほかの入口との分離、pack した成果物の型検査と実行 | `bigtable.test.ts`、`bigtable-package.test.ts`、`bigtable-entry-isolation.test.ts`、`packages/tests/e2e/bigtable-entry-isolation.test.cjs`、`packages/tests/e2e/external-consumption.test.cjs`、`packages/tests/e2e/workspace-consumption.test.cjs` |
| 文書 | README の例（初回と再起動）は英語と日本語で同一で、公開の型で型検査に通り、エミュレーターで動く | `internal/bigtable-documents.test.ts`（エミュレーター） |
| 要求の分割 | ReadRows の再開を除いて該当なし。ほかの要求はどれも 1 行だけを扱う | 上の BT-10 の試験 |

## 3. 適合の実行

`pnpm --filter event-store-adapter-js run coverage --runInBand` は、`coverage/conformance`（または `CONFORMANCE_REPORT_DIR`）に、メモリ・DynamoDB・SQLite・Spanner のレポートと並べて `bigtable.json` を書きます。`conformance-bigtable.test.ts` は、必須のケースが実行されない・失敗する・未検証・表せないときに失敗します。実行器は、1 つのエミュレーターの中でケースごとに新しい 2 テーブルを作り、試験用のフックで障害を差し込み（要求を送る前に失敗させる `replace-request`、条件付き更新を送った後に応答を失わせる `replace-response`）、保存済みの履歴は同じ公開の要求の経路で読みます。直近の手元の実行の結果は、合格 87、失敗 0、未検証 0、表せない 0、対象外 8（`Date` で表せないナノ秒のケース）で、ほかの保存先を対象とする 74 件は `backendNotApplicable` として報告されます。
