## MODIFIED Requirements

### Requirement: Spanner EventStore construction
MUST: `EventStore.createSpanner(...)` から Cloud Spanner 用 `EventStore` アダプタを構築できること。
システムは `EventStore.createSpanner(...)` から Cloud Spanner 用 `EventStore` アダプタを公開しなければならない。

#### Scenario: Construct Spanner EventStore
- **WHEN** 呼び出し側が valid な `SpannerEventStoreInput` を渡す
- **THEN** `EventStore.createSpanner(...)` は、渡された Spanner `Database` を使う `EventStore` 実装を返す

#### Scenario: 古い Spanner ファクトリ名は削除される
- **WHEN** 呼び出し側が `EventStore` をランタイム値として取り込む
- **THEN** `EventStore.ofSpanner(...)` は公開 API に含まれない
