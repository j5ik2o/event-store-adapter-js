## Why

現在のライブラリは DynamoDB とインメモリの `EventStore` 実装を提供しているが、GCP を利用するユーザー向けに Cloud Spanner を永続化先にしたアダプタがない。Spanner はイベントとスナップショットの原子的な書き込みを維持でき、将来的には `journal` 起点の Change Streams 連携にも発展させやすい。

## What Changes

- `EventStoreFactory.ofSpanner(...)` から利用できる Cloud Spanner 用 `EventStore` アダプタを追加する。
- 呼び出し側が構成済みの Spanner `Database`、テーブル名、converter、serializer、shard 設定、logger を渡せる `SpannerEventStoreInput` を追加する。
- 既存の VO 重視の設計に合わせて、DynamoDB / Spanner 共通の `ShardSelector` と `ShardId` 値オブジェクトを追加する。
- Spanner の `journal` / `snapshot` テーブル向け GoogleSQL schema ドキュメントを追加する。
- イベントとスナップショットの payload は serializer が生成した bytes として保存する。
- DynamoDB 版と同じ snapshot 意味論を維持する。`sequence_number = 0` を最新 snapshot、`sequence_number > 0` を任意の保持用 snapshot copy とする。
- `keepSnapshotCount` による保持用 snapshot のハード削除をサポートする。
- 初期実装では delayed TTL deletion と Change Streams 実装は対象外にする。

## Capabilities

### New Capabilities

- `spanner-event-store`: Cloud Spanner を永続化先にした `EventStore` の保存、読み取り、楽観ロック、shard 選択、snapshot retention、GoogleSQL schema ドキュメント。

### Modified Capabilities

- なし。

## Impact

- Public API: `EventStoreFactory.ofSpanner(...)`, `SpannerEventStoreInput`, `ShardSelector`, `ShardId`。
- Runtime dependency: `@google-cloud/spanner`。
- Internal implementation: Spanner adapter、shard selector、aggregate key handling、snapshot retention executor。
- Tests: 既存の `EventStore` contract test suite を Spanner emulator 上で実行する。
- Documentation: README の利用例と Spanner schema 説明。将来の Change Streams 連携では `journal` のみを監視対象にする方針も明記する。
