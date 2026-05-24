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

### Requirement: Optimistic locking
MUST: Spanner adapter は楽観ロック失敗を `OptimisticLockError` ではなく `Result.err(EventStoreError.*)` で返すこと。
Spanner adapter は既存の optimistic locking semantics を維持しつつ、失敗表現を Result ベースのエラー契約へ移行しなければならない。

#### Scenario: Unknown aggregate update
- **WHEN** `persistEvent(...)` が latest snapshot を持たない aggregate に対して呼び出される
- **THEN** adapter は `Result.err(...)` を返す
- **AND** 返された `EventStoreError` は楽観ロック失敗を表す `type` を持つ

#### Scenario: Stale version
- **WHEN** latest snapshot version が expected version と異なる
- **THEN** adapter は `Result.err(...)` を返す
- **AND** 返された `EventStoreError` は楽観ロック失敗を表す `type` を持つ

#### Scenario: Duplicate created event
- **WHEN** 既に存在する aggregate に対して created event が保存される
- **THEN** adapter は `Result.err(...)` を返す
- **AND** 返された `EventStoreError` は楽観ロック失敗を表す `type` を持つ

#### Scenario: Duplicate journal row
- **WHEN** journal row の insert 時に Spanner が `ALREADY_EXISTS` を返す
- **THEN** adapter は failure を `Result.err(...)` に変換する
- **AND** 返された `EventStoreError` は楽観ロック失敗を表す `type` を持つ

### Requirement: Spanner transaction abort handling
MUST: transaction `ABORTED` は Spanner client の retry behavior に委ねること。
Spanner adapter は transaction `ABORTED` の retry behavior を Spanner client に任せ、最終的な unrecovered abort を optimistic lock error として再分類してはならない。

#### Scenario: Transaction abort
- **WHEN** concurrency により Spanner が read-write transaction を abort する
- **THEN** adapter は Spanner client の transaction retry mechanism に処理させる
- **THEN** 最終的に残った unrecovered abort は楽観ロック失敗の `EventStoreError` に変換せず、ストレージ失敗を表す `EventStoreError` として返す
