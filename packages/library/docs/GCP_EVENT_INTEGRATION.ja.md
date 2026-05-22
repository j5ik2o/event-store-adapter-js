# GCPにおけるイベント駆動連携の選択肢

このドキュメントは、`DynamoDB Streams + Lambda` に近い後段処理を GCP 上で実現する場合の選択肢を整理したものです。  
対象日時は `2026-03-12` 時点です。

## 結論

- `Cloud Pub/Sub + Cloud Functions` は `DynamoDB Streams + Lambda` の直接代替ではありません
- DB 変更を起点にしたい場合は、`Firestore trigger` または `Spanner Change Streams` を使うべきです
- このライブラリの Event Store と相性がよい候補は `Firestore` と `Spanner` です
- `Bigtable` は現実的ではありません

## 対応関係

| AWS | GCPで近い構成 | 補足 |
|:--|:--|:--|
| DynamoDB Streams + Lambda | Firestore trigger + Cloud Functions | 実装は軽いが、DB 製品は DynamoDB とはかなり性質が違う |
| DynamoDB Streams + Lambda | Spanner Change Streams + Dataflow + Cloud Run functions / Cloud Functions | 変更ストリーム起点の構成としては最も近い |
| SNS / SQS / EventBridge 的な非同期配信 | Cloud Pub/Sub | `Pub/Sub` 自体は DB 変更ストリームではない |

## 比較表

| 候補 | DB変更を自動検知 | 原子的なイベント保存とスナップショット更新 | 後段連携のしやすさ | Event Store との相性 | 推奨度 |
|:--|:--|:--|:--|:--|:--|
| Firestore + Cloud Functions | 可能 | 可能 | 高い | 高い | 高 |
| Spanner + Change Streams | 可能 | 可能 | 高い | 高い | 高 |
| Firestore + Pub/Sub + Cloud Functions | 条件付きで可能 | 可能 | 高い | 高い | 中 |
| Bigtable + Pub/Sub + Cloud Functions | 直接は不可 | 弱い | 中 | 低い | 低 |
| Pub/Sub 単体 | 不可 | DB 依存 | 高い | 低い | 用途次第 |

## それぞれの位置づけ

### Firestore

- ドキュメント更新をトリガーに `Cloud Functions` を起動できます
- トランザクションで複数ドキュメントを原子的に更新できます
- `journal` ドキュメントの作成だけをトリガー対象にすると、`snapshot` 更新による二重起動を避けやすいです

推奨パターン:

| 用途 | 推奨 |
|:--|:--|
| イベント保存 | `aggregates/{aggregateId}/journal/{sequenceNumber}` |
| 最新スナップショット | `aggregates/{aggregateId}/snapshot/latest` |
| 後段トリガー | `journal` 配下の `onCreate` |

向いているケース:

- 実装量を抑えたい
- サーバレス寄りに寄せたい
- 後段処理を `Cloud Functions` で素直につなぎたい

### Spanner

- `read-write transaction` により、イベントとスナップショットの同時更新を自然に表現できます
- `Change Streams` により、DB 変更をストリームとして取り出せます
- `DynamoDB Streams` に一番近い運用感です

推奨パターン:

| 用途 | 推奨 |
|:--|:--|
| イベント保存 | `journal` テーブル |
| 最新スナップショット | `snapshot` テーブル |
| 後段トリガー | `Change Streams -> Dataflow -> Pub/Sub or Cloud Run functions` |

向いているケース:

- `DynamoDB Streams + Lambda` に近い構成を求める
- トランザクション整合性を明確に取りたい
- 将来的なデータ量や運用制御を重視する

### Cloud Pub/Sub

- `Pub/Sub` はメッセージ配信基盤です
- DB の変更を自動検知する機能ではありません
- したがって、`DynamoDB Streams` の代わりに単独で置くことはできません

使いどころ:

| 使い方 | 妥当性 |
|:--|:--|
| DB変更の直接検知 | 低い |
| Change Streams / trigger の後段バス | 高い |
| サービス間の疎結合連携 | 高い |

## Bigtable が現実的でない理由

`Bigtable` は、このライブラリが前提にしている Event Store の書き込み条件と相性がよくありません。

| 観点 | Bigtable の制約 | Event Store への影響 |
|:--|:--|:--|
| トランザクション | 基本的に単一行の原子性 | `journal` と `snapshot` の同時更新を自然に扱えない |
| 楽観ロック | 一般的な RDB / Firestore / Spanner より表現しづらい | `version` 条件付き更新の設計が不自然になる |
| 変更ストリーム | `DynamoDB Streams` 相当の素直な連携ではない | 後段処理の構成が複雑になる |
| クエリ | Event Store 向けの取得パターンに対して素直ではない | 実装と運用の両方が重くなりやすい |

要するに、`Bigtable` は高スループットなワイドカラムストアとしては優秀ですが、このライブラリが必要とする:

- イベント保存
- 最新スナップショット更新
- 楽観ロック
- 後段への変更通知

をバランスよく満たす基盤ではありません。

## 推奨アーキテクチャ

### 実装を急ぐ場合

| 項目 | 推奨 |
|:--|:--|
| ストア | Firestore |
| 後段処理 | Firestore trigger + Cloud Functions |
| 理由 | 実装量が少なく、サーバレス構成に寄せやすい |

### DynamoDB Streams に近い構成を優先する場合

| 項目 | 推奨 |
|:--|:--|
| ストア | Spanner |
| 後段処理 | Change Streams + Dataflow + Pub/Sub / Cloud Run functions |
| 理由 | DB変更ストリーム起点の構成が最も近い |

## 設計上の注意

| 論点 | 注意点 |
|:--|:--|
| 重複実行 | `Cloud Functions` も `Pub/Sub` も再配信・再実行を前提に冪等にする |
| 監視対象 | `snapshot` ではなく `journal` を起点にする |
| 順序 | 集約単位での順序保証を後段でどう担保するかを決める |
| 再実行 | downstream は `event.id` や `aggregateId + sequenceNumber` で重複排除できるようにする |

## このライブラリに対する示唆

GCP 対応を追加する場合、最初の候補は次の 2 つです。

| 候補 | 判断 |
|:--|:--|
| `EventStoreForFirestore` | 実装量優先なら最初の候補 |
| `EventStoreForSpanner` | `DynamoDB Streams` に近い構成を重視するなら最初の候補 |

`Bigtable` 向けアダプタは、少なくとも最初の GCP 対応としては推奨しません。

## 参考

- Firestore triggers: https://cloud.google.com/functions/docs/calling/cloud-firestore
- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Cloud Functions retries: https://docs.cloud.google.com/functions/docs/bestpractices/retries
- Cloud Pub/Sub overview: https://docs.cloud.google.com/pubsub/docs/pubsub_overview
- Pub/Sub exactly-once delivery: https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery
- Spanner Change Streams: https://docs.cloud.google.com/spanner/docs/change-streams
- Spanner emulator: https://cloud.google.com/spanner/docs/emulator
- Bigtable writes and atomicity: https://cloud.google.com/bigtable/docs/writes
