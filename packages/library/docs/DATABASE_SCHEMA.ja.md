# DynamoDBのテーブル構成

同一リージョンに独立した3表を作成します。表作成は呼び出し側が行い、`EventStore.createDynamoDB` が共通設定項目を照合します。表名と履歴index名は入力で指定します。

| 表 | パーティションキー | ソートキー | Index / Streams |
| --- | --- | --- | --- |
| journal | `aid` S | `seq_nr` N | GSI・Streamsなし |
| snapshot | `aid` S | `skey` N | 指定した履歴GSI: `aid` S + `active_history_seq_nr` N、KEYS_ONLY |
| head | `aid` S | なし | Streams有効、NEW_IMAGE |

TTL方式の保持を使う場合だけsnapshot表の `ttl` を有効化します。journalとheadにはTTLを設定しません。

## 設定項目

3表とも `aid = "__config__"` とし、journalは `seq_nr = 0`、snapshotは `skey = 0` を加えます。各設定項目に `store_id` Sと `layout_version` N（`1`）を保存します。3項目のstore IDは同一の空でない値でなければなりません。全項目がなければ1つの条件付きトランザクションで作成します。部分存在、不一致、未対応の版では生成に失敗します。設定項目は集約の項目とは別です。

## Journal項目

| 属性 | 型 | 内容 |
| --- | --- | --- |
| aid | S | `typeName-value` |
| seq_nr | N | 1から始まる連続イベント番号 |
| occurred_at | N | JavaScriptの完全なエポックミリ秒値×1,000,000によるエポックナノ秒 |
| manifest | S | Serializerのスキーマ識別子。既定は空文字 |
| payload | B | ドメインイベントのpayloadだけを直列化したbytes |

journal本体を強整合でQueryします。`seq_nr >= start` は開始番号を含み、すべてのLastEvaluatedKeyをたどり、昇順に返します。

## Head項目

headには `aid` S、`type_name` S、`seq_nr` N、`events` Lがあります。リストは確定した1イベントのMを持ち、その属性は `seq_nr` N、`occurred_at` N、`manifest` S、`payload` Bです。headのStreamsはNEW_IMAGEを提供します。このAPIには変更フィード操作はありません。

初回イベントでheadを条件付き作成します。以後は既存head番号が `seqNr - 1` と一致する必要があります。head更新とjournal書き込みは原子的に確定します。旧versionに代わりシーケンス番号で楽観ロックを行います。

## 現在と履歴のSnapshot項目

現在snapshotは `skey = 0` です。属性は `aid` S、`skey` N、`seq_nr` N、`last_updated_at` N、`manifest` S、`payload` Bです。snapshot番号はソートキーではなく `seq_nr` にあります。`last_updated_at` は書き込みイベントの完全なエポックミリ秒です。現在snapshotにTTLや履歴markerはありません。

保持設定がある場合は同じトランザクションで履歴も作り、`skey = seq_nr`、`active_history_seq_nr = seq_nr` とします。保持設定なしでは履歴を作りません。event-only書き込みは現在snapshotを変えず、保持要求も送りません。

現在snapshotとは別に、最新の有効履歴を指定件数保持します。削除方式は古い履歴を削除します。TTL方式は `ttl` N（印付け時のエポック秒＋`graceSeconds`）を追加し、`active_history_seq_nr` を原子的に除去します。印付き項目の既存期限は変えず、疎なGSIにも含めません。`payload` に保存するのはドメイン集約だけです。

headとsnapshotを含む各実項目の上限は409600バイトです。トランザクションはjournal、head、指定された現在・履歴snapshotを含み、項目が超過した場合はcommit送信前に失敗します。

## 復元と移行

最新snapshotはheadと現在snapshotを強整合のBatchGetItemで読みます。この読取は原子的ではなく、`headSeqNr` と独立して読んだsnapshotを返します。復元は `snapshot.seqNr + 1`、snapshotなしなら1から始めます。

旧2表・shard配置は新しい表への書き直しが必要です。[移行ガイド](MIGRATION_GUIDE.ja.md) を参照してください。新版のreaderは旧項目を変換しません。
