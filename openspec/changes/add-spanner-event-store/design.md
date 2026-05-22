## Context

現在のライブラリは、storage-neutral な `EventStore` interface と DynamoDB / インメモリ実装を提供している。DynamoDB adapter は、aggregate id、serializer、converter、assertion、contract test を再利用し、ドメイン向け契約と永続化詳細を分離している。

Cloud Spanner 対応でもこの契約を再利用しつつ、Spanner のリレーショナルモデルに合わせる。加えて、既存実装の VO 重視の設計を保つ。aggregate identity は `AggregateId` のまま扱い、storage 由来でも意味を持つ値は untyped primitive として広く渡さない。

## Goals / Non-Goals

**Goals:**

- 既存 adapter と同じ4つの public operation を持つ Spanner-backed `EventStore` を追加する。
- `EventStoreFactory.ofSpanner(...)` から Spanner 実装を作成できるようにする。
- DynamoDB 版が caller-managed client を受け取る方針に合わせ、caller-managed Spanner `Database` を受け取る。
- serializer が生成した bytes を Spanner に保存し、payload 処理を DynamoDB と共有する。
- `ShardId` と `SpannerShardSelector` を使い、shard 選択を明示的かつ VO-oriented にする。
- `journal` / `snapshot` 向け GoogleSQL DDL を定義する。
- 既存の楽観ロックと snapshot replay の意味論を維持する。
- 既存の `EventStore` contract test suite を Spanner emulator 上で実行して検証する。

**Non-Goals:**

- Change Streams、Dataflow、Pub/Sub、downstream handler は実装しない。
- 初期実装では Spanner PostgreSQL interface をサポートしない。
- DynamoDB の `deleteTtlMillis` 相当の delayed TTL deletion は追加しない。
- DynamoDB と Spanner をまたぐ共通 persistence base class は導入しない。
- 内部の Spanner row-key object は public API に出さない。

## Decisions

### 既存 EventStore 契約の背後に Spanner 専用 adapter を追加する

`SpannerEventStore` は `EventStore` を実装し、`EventStoreFactory.ofSpanner(...)` から構築する。これにより repository code は storage-neutral のままになり、既存の `ofDynamoDB(...)` / `ofMemory(...)` とも揃う。

代替案として generic SQL adapter も考えられるが、2つ目の SQL backend がない段階で抽象化すると、最初の Spanner 実装の検証が難しくなる。

### Caller-managed Spanner Database を受け取る

`SpannerEventStoreInput` は `@google-cloud/spanner` の `Database` を受け取る。adapter は Spanner client を作成せず、close もしない。

代替案として project / instance / database ID を受け取って内部で client を作る方法もあるが、認証、emulator 設定、resource lifecycle、adapter construction が結合してしまう。

### GoogleSQL と typed relational key を使う

初期 schema は GoogleSQL の typed columns を使う。

```sql
CREATE TABLE journal (
  shard_id INT64 NOT NULL,
  aggregate_id STRING(MAX) NOT NULL,
  sequence_number INT64 NOT NULL,
  payload BYTES(MAX) NOT NULL,
  occurred_at TIMESTAMP NOT NULL
) PRIMARY KEY (shard_id, aggregate_id, sequence_number);

CREATE TABLE snapshot (
  shard_id INT64 NOT NULL,
  aggregate_id STRING(MAX) NOT NULL,
  sequence_number INT64 NOT NULL,
  version INT64 NOT NULL,
  payload BYTES(MAX) NOT NULL,
  updated_at TIMESTAMP NOT NULL
) PRIMARY KEY (shard_id, aggregate_id, sequence_number);
```

代替案として DynamoDB 版の `pkey` / `skey` 文字列列を再利用する案もあるが、DynamoDB の storage concern を Spanner に漏らし、SQL と運用確認を読みにくくする。

### Snapshot semantics は DynamoDB 版と互換にする

`snapshot` table では `sequence_number = 0` を最新 snapshot とする。任意の保持用 snapshot copy は `sequence_number > 0` を使う。

`persistEvent(...)` は最新 snapshot の payload を変更せず version だけ進める。`persistEventAndSnapshot(...)` は最新 snapshot payload を更新し、`keepSnapshotCount` が指定されている場合は保持用 snapshot copy も insert する。

代替案として latest snapshot と retained snapshot を別テーブルに分ける方法もあるが、`EventStore` 契約を変えない割に schema と実装面が増える。

### Shard と aggregate key の VO 境界を保つ

`ShardId` は `createShardId(value: number)` から作る public branded value object とする。`SpannerShardSelector<AID>` は `ShardId` を返す。

内部では `SpannerAggregateKey<AID>` が以下を保持する。

```ts
type SpannerAggregateKey<AID extends AggregateId> = {
  shardId: ShardId;
  aggregateId: AID;
};
```

adapter は SQL boundary でのみ `aggregateId.asString()` と `ShardId` を Spanner parameter value に変換する。

代替案として Spanner 実装内で `number` と `string` をそのまま渡す方法もあるが、既存の VO style を弱め、row-key construction の誤用を招きやすい。

### shardCount は public input では primitive のままにする

`SpannerEventStoreInput.shardCount` は `DynamoDBEventStoreInput` と合わせて `number` のままにする。adapter は使用前に positive integer として normalize する。

代替案として public `ShardCount` VO を導入する案もあるが、Spanner だけ DynamoDB より厳しい API になり、必要性が実証される前に API friction が増える。

### 楽観ロックには read-write transaction を使う

Spanner write は read-write transaction 内で行う。adapter は最新 snapshot row を読み、`version` を比較し、journal row を insert し、最新 snapshot row を update または insert して atomic に commit する。

version mismatch、update 対象 aggregate の欠落、duplicate created event、duplicate journal insert は `OptimisticLockError` に変換する。Spanner の `ALREADY_EXISTS` は `OptimisticLockError` に変換する。`ABORTED` は Spanner client の transaction retry mechanism に任せ、最終的に残った unrecovered error は再分類しない。

代替案として snapshot を先に読まず DML row count や insert error だけに頼る方法もあるが、expected-version behavior が不明瞭になり、既存 contract test との整合性を保ちにくい。

### Commit time ではなく event time を保存する

`journal.occurred_at` は `event.occurredAt` を保存する。`snapshot.updated_at` も対応する `event.occurredAt` を保存する。

代替案として commit timestamp を使う方法もあるが、`EventStore` 契約上の時刻は domain event time である。監査や Change Streams 用に commit time が必要になった場合は、将来 `committed_at` を追加できる。

### Snapshot retention は hard delete のみにする

`keepSnapshotCount` が指定されている場合、adapter は aggregate ごとに最新の保持用 snapshot copy を残し、それより古い保持用 snapshot copy を hard delete する。初期の `SpannerEventStoreInput` には `deleteTtlMillis` option を追加しない。

代替案として Spanner row deletion policy や scheduled cleanup で DynamoDB TTL を模倣する案もあるが、初期 adapter には不要な運用モデルを追加してしまう。

### Change Streams は journal-only 方針をドキュメントに残す

初期実装では Change Streams を作成しない。将来の downstream integration では `snapshot` ではなく `journal` を監視対象にする、と documentation に明記する。snapshot は replay 高速化と楽観ロックのための内部状態だからである。

## Risks / Trade-offs

- [Spanner emulator と production behavior が異なる] -> tests は contract-focused にし、emulator 利用を documentation に明記する。emulator-only behavior には依存しない。
- [Transaction retry で callback が再実行される] -> transaction body は deterministic にし、外部 side effect を入れない。
- [Commit 後の snapshot retention が失敗する] -> retention error は握りつぶさず伝播し、persistence-related result を黙殺しない project rule に合わせる。
- [大きな BYTES payload により storage / read cost が増える] -> compatibility を優先して payload shape は維持する。将来の compression は serializer の背後に追加できる。
- [shardCount 変更で既存 aggregate row の配置が変わる] -> `shardCount` は既存 data に対して安定させるべき schema/configuration として扱う。
