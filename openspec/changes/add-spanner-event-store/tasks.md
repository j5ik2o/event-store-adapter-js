## 1. Public API and Types

- [x] 1.1 `@google-cloud/spanner` を runtime dependencies に追加し、lockfile を更新する。
- [x] 1.2 validation 付きの public `ShardId` value object と `createShardId(...)` を追加する。
- [x] 1.3 `ShardId` を返す public `SpannerShardSelector` interface を追加する。
- [x] 1.4 既存の hash distribution 方針を使う internal `DefaultSpannerShardSelector` を追加する。
- [x] 1.5 caller-managed `Database`、table names、shard count、converters、optional serializers、optional shard selector、optional retention、optional logger を持つ `SpannerEventStoreInput` を追加する。
- [x] 1.6 新しい public Spanner input、shard selector、shard ID types を `src/index.ts` から export する。
- [x] 1.7 既存の DynamoDB / memory factory behavior を変えずに `EventStoreFactory.ofSpanner(...)` を追加する。

## 2. Spanner Core Implementation

- [x] 2.1 `aggregateId` を `AggregateId`、`shardId` を `ShardId` として保持する internal `SpannerAggregateKey` creation を追加する。
- [x] 2.2 converters と positive integer `shardCount` の Spanner configuration validation を追加する。
- [x] 2.3 `(shard_id, aggregate_id)` filtering と ascending `sequence_number` を使って `getEventsByIdSinceSequenceNumber(...)` を実装する。
- [x] 2.4 `sequence_number = 0` を読み、stored version を deserialized snapshot に適用する `getLatestSnapshotById(...)` を実装する。
- [x] 2.5 created event persistence を1つの read-write transaction で実装する。
- [x] 2.6 latest snapshot payload を置き換えない event-only update persistence を1つの read-write transaction で実装する。
- [x] 2.7 update-with-snapshot persistence を1つの read-write transaction で実装する。
- [x] 2.8 `event.occurredAt` を `journal.occurred_at` と `snapshot.updated_at` に保存する。
- [x] 2.9 explicit version conflict、missing aggregate、duplicate created event、Spanner `ALREADY_EXISTS` insert failure を `OptimisticLockError` に変換する。
- [x] 2.10 最終的な unrecovered Spanner transaction abort と infrastructure errors は変換せず伝播する。

## 3. Snapshot Retention

- [x] 3.1 `keepSnapshotCount` 向けの Spanner retained snapshot writes を追加する。
- [x] 3.2 最新 `keepSnapshotCount` rows より古い retained snapshots を hard-delete する retention を追加する。
- [x] 3.3 retention failures を握りつぶさず伝播する。
- [x] 3.4 `SpannerEventStoreInput` には delayed TTL deletion を入れない。

## 4. Tests

- [x] 4.1 testcontainers を使う Spanner emulator test utilities を追加する。
- [x] 4.2 journal / snapshot tables 向け Spanner schema setup helpers を追加する。
- [x] 4.3 既存の `runEventStoreContractTests(...)` suite を `SpannerEventStore` に対して実行する。
- [x] 4.4 invalid converters と invalid shard counts の Spanner-specific tests を追加する。
- [x] 4.5 `ShardId` validation と default shard selection の tests を追加する。
- [x] 4.6 retained snapshot hard deletion の tests を追加する。
- [x] 4.7 可能な範囲で `ALREADY_EXISTS` から `OptimisticLockError` への変換 tests を追加する。

## 5. Documentation and Verification

- [x] 5.1 Spanner GoogleSQL schema documentation を追加する。
- [x] 5.2 Change Streams は初期 scope 外であり、将来の downstream integration では `snapshot` ではなく `journal` を監視対象にすることを document する。
- [x] 5.3 `EventStoreFactory.ofSpanner(...)` の README usage を追加する。
- [x] 5.4 formatter、lint、typecheck/build、relevant Jest tests を実行する。
- [x] 5.5 prohibited vague suffixes と swallowed `Result`-like promises がないか implementation を review する。
