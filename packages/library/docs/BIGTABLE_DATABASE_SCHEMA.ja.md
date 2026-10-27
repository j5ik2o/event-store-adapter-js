> この文書は [BIGTABLE_DATABASE_SCHEMA.md](BIGTABLE_DATABASE_SCHEMA.md) の日本語版です。英語版が正本で、食い違うときは英語版に従います。

# Bigtable の保存先のスキーマ

## 配置

この文書は、入口 `event-store-adapter-js/bigtable` の `BigtableEventStore.initialize(...)` が用意し、`BigtableEventStore.create(...)` が開く 2 つのテーブルを説明します。使い方は [現在のREADME](../README.ja.md) を参照してください。配置は Rust 版と同じなので、どちらの実装が作ったテーブルも、もう一方が読み書きできます。

2 つのテーブルと列ファミリは、すでにあるインスタンスに利用者が作ります。ライブラリはテーブルも列ファミリも作りません。

| テーブル | 列ファミリ | 行キー |
|:--|:--|:--|
| journal | `event`・`history`・`config` | `P ‖ U64BE(seq_nr)` |
| head | `head`・`snapshot`・`config` | `P` |

`P = H ‖ L16 ‖ A` です。`A` は集約 ID（`<typeName>-<value>`）の UTF-8 のバイト列、`L16` は `A` のバイト数を符号なし 16bit のビッグエンディアンにしたもの、`H` は `A` の FNV-1a 64 を 8 バイトのビッグエンディアンにしたものです。長さを含めるので、ハッシュが衝突しても、ある集約の `P` が別の集約の `P` の前方一致になりません。行キーはバイト列として比べ、`seq_nr` は 8 バイトのビッグエンディアンなので、journal の行のバイト順は `seq_nr` の数値の順と同じです。各テーブルの設定行の行キーは 1 バイトの `0x00` で、データ行のキーはこれと一致しません。

データの列ファミリ（`event`・`history`・`head`・`snapshot`）はどれも、ちょうど 1 版だけを残す GC の規則（最大 1 版）を持ち、年齢による規則を持ちません。ファミリが欠けているテーブルや、別の規則のテーブルは、開くときに拒否されます。`config` は存在だけを見ます。セルの時刻は常に 0 で、置き換える列は先に全版を削除するので、列には 1 つのセルだけがあります。

## 設定

各テーブルは行キー `0x00` の 1 行を持ち、そのセル `config:metadata` は、両テーブルで同じ値の JSON です。

| キー | 値 |
|:--|:--|
| `store_id` | 小文字の UUID。`initialize` が生成します |
| `layout_version` | `1` |
| `keep_snapshot_count` | クライアントの `retention.count` を `"2"` のような 10 進文字列にしたもの。保持なしなら `null` |
| `retention_mode` | `"delete"` |
| `envelope_limit_bytes` | クライアントの `envelopeLimitBytes`。既定は `1048576` |

最上位のキーは重複してはいけません。先頭にゼロがある `keep_snapshot_count`、指数表記のもの、数値型のものは拒否されます。`create` がテーブルを開くとき、2 つの行は等しく、クライアントの `retention.count` と `envelopeLimitBytes` に一致する必要があります。違いは `configuration-error` です。この版は変更フィードを提供しないので、`changeFeed` を渡すと `configuration-error` です。

## 初期化

1. journal のテーブルに列ファミリ `event`・`history`・`config` を、head のテーブルに `head`・`snapshot`・`config` を作ります。4 つのデータの列ファミリには、最大 1 版の規則を付けます。
2. `BigtableEventStore.initialize(input)` を一度だけ呼びます。列ファミリを確かめてから、セルがないときだけ成功する条件付き更新で、両方のテーブルへ設定のセルを書きます。どちらかのテーブルに設定行がすでにあれば、何も書かず `configuration-error` です。
3. 同じ設定で `BigtableEventStore.create(input)` を呼んでテーブルを開きます。`create` は何も初期化しません。テーブル・列ファミリ・設定行が欠けていれば `configuration-error` です。

`Bigtable` クライアントは呼び出し側が作り、閉じます。エミュレーターには `BIGTABLE_EMULATOR_HOST` を設定するか `apiEndpoint` を渡します。どちらも、SDK は暗号化しない接続を認証なしで使います。

## 記録

| テーブル | セル | 値 |
|:--|:--|:--|
| journal | `event:envelope` | イベントの封筒 |
| journal | `event:has_snapshot` | イベントと同時にスナップショットを書いたなら `1`、そうでなければ `0` |
| journal | `history:state` | `active` または `retired`（保持があるときだけ） |
| journal | `history:envelope` | 履歴として残すスナップショットの封筒（`active` の間だけ） |
| head | `head:seq_nr` | head の番号を 20 桁の ASCII 数字にしたもの |
| head | `head:last_event` | head のイベントの封筒 |
| head | `head:has_snapshot` | `1` または `0` |
| head | `snapshot:current` | 最新のスナップショットの封筒 |

数値はすべてビッグエンディアンです。イベントの封筒は `0x01 ‖ U16(aid の長さ) ‖ aid ‖ U64(seq_nr) ‖ I64(occurred_at_ns) ‖ U32(manifest の長さ) ‖ manifest ‖ U32(payload の長さ) ‖ payload`、スナップショットの封筒は `0x01 ‖ U64(seq_nr) ‖ U32(manifest の長さ) ‖ manifest ‖ U32(payload の長さ) ‖ payload` です。末尾の余り・長さの不一致・未知の版は、封筒を読めないものとして `storage-error` にします。1 つの封筒は `envelopeLimitBytes` バイト以下で、超えるものは何も書く前に規則 `BT-16` の `contract-violation` になります。

## 書き込みと読み取り

追記は次の順に進みます。まず入力の検査と直列化を済ませ、head の行を強整合で読んで、新しい `seq_nr` を head の `h` と比べます。head の行にしかない `h` のイベントを、その journal の行へ書き出します（行がすでにあれば書きません）。次に head の行を 1 回の条件付き更新で進めます。`head:seq_nr` がまだ `h`（最初のイベントならまだ無い）のときだけ成功し、この成功が確定点です。最後に、新しい末尾のイベントを journal の行へ書き出します。

- 条件付き更新が成功しなければ `optimistic-lock-conflict` です。応答を失った場合は `storage-error` で、要求は再送しません。やり直すと、確定済みの head を読んで `optimistic-lock-conflict` になります。
- 直前のイベントを書き出せなければ、head を進める前に追記が止まります。確定後に新しい末尾の行を書き出せなくても結果は変わらず、`onJournalWriteFailure` と logger に通知され、次の追記が欠けた行を書き出します。
- journal の行は `event:envelope` がないときだけ作ります。遅れた書き手は、既存の行を上書きせず、`retired` の履歴も復活させません。

読み取りは head の行を 1 回だけ読み、その `h` を呼び出しの間ずっと使います。`getLatestSnapshotById` は、その 1 つの行から `head:*` と `snapshot:current` を読みます。`getEventsByIdSinceSeqNr(id, start)` は、head がない場合と `start > h` の場合は何も返さず、`start = h` なら head のイベントだけを返し、それ以外は journal の `[start, h)` の行に head のイベントを続けて返します。journal の範囲に欠番があれば `storage-error` です。範囲の読み取りが途中で切れたら、最後に完成した行の次から再開します。

## 保持

`retention` がなければ履歴を残さず、journal の行はイベントだけを持ちます。`retention: { count }` があると、スナップショットを伴う追記は、そのスナップショットを `history:envelope` として journal の行へ書き、`history:state = active` にします。確定後に、行 `[1, h]` の `history:state` のセルだけを読み、新しい `count` 件の active な履歴を残して、古いものを `retired` にし、その `history:envelope` を削除します。`event` のセルは残すので、`retired` の行もイベントとして読め、遅れた書き手が作り直すことはできません。この手順の失敗は `onRetentionFailure` と logger に通知され、成功した追記を変えず、次のスナップショットを伴う追記でやり直されます。TTL による保持には対応しません（`configuration-error`）。

## 運用

- 稼働中の操作には 1 つの app profile（`Bigtable` クライアントの `appProfileId`）を使い、読み取りと条件付き更新が同じクラスタで会うようにします。
- `accessToken` は、データと管理を問わずすべての要求の直前に呼ばれ、保持されません。ログに出さないでください。ライブラリはエラーメッセージにトークンを入れません。
- 通知先が例外を投げても、確定済みの追記の結果は変わりません。
- 試験は Testcontainers で起動した Cloud Bigtable エミュレーターを使い、実サービスへは接続しません。
