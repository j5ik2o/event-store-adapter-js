## ADDED Requirements

### Requirement: Spanner factory construction
システムは `EventStoreFactory.ofSpanner(...)` から Cloud Spanner 用 `EventStore` adapter を公開しなければならない。

#### Scenario: Construct Spanner EventStore
- **WHEN** 呼び出し側が valid な `SpannerEventStoreInput` を渡す
- **THEN** `EventStoreFactory.ofSpanner(...)` は、渡された Spanner `Database` を使う `EventStore` implementation を返す

### Requirement: Caller-managed Spanner database
Spanner adapter は caller-managed Spanner `Database` を受け取らなければならず、内部で Spanner client を作成または close してはならない。

#### Scenario: Use provided Database
- **WHEN** Spanner EventStore が作成される
- **THEN** すべての read、write、transaction は `SpannerEventStoreInput` の `Database` を使う

### Requirement: Shard value object
システムは `ShardId` value object と、`ShardId` を返す `SpannerShardSelector` を提供しなければならない。

#### Scenario: Select shard for aggregate
- **WHEN** Spanner adapter が aggregate ID の row key を組み立てる
- **THEN** `SpannerShardSelector.selectShardId(...)` を使って `ShardId` を取得する
- **THEN** SQL boundary で parameter に変換するまでは aggregate identity を `AggregateId` として保持する

### Requirement: Valid shard configuration
Spanner adapter は shard selection に使う前に invalid な shard count を拒否しなければならない。

#### Scenario: Invalid shard count
- **WHEN** `SpannerEventStoreInput.shardCount` が positive integer ではない
- **THEN** Spanner EventStore construction は configuration error で失敗する

### Requirement: GoogleSQL schema
Spanner adapter は shard ID、aggregate ID、sequence number、payload、event timestamp 向け typed columns を使った GoogleSQL の `journal` / `snapshot` table をドキュメント化しなければならない。

#### Scenario: Schema documentation
- **WHEN** ユーザーが Spanner schema documentation を読む
- **THEN** `journal` は primary key `(shard_id, aggregate_id, sequence_number)` として定義されている
- **THEN** `snapshot` は primary key `(shard_id, aggregate_id, sequence_number)` として定義されている

### Requirement: Serializer-compatible payload storage
Spanner adapter は configured serializer が生成した bytes として event / snapshot payload を保存しなければならない。

#### Scenario: Persist and read payload
- **WHEN** event または snapshot が Spanner に書き込まれる
- **THEN** adapter は serializer-produced bytes を `BYTES(MAX)` payload column に保存する
- **WHEN** その値が読み取られる
- **THEN** adapter は configured serializer と converter を使って deserialize する

### Requirement: Persist created event and latest snapshot atomically
Spanner adapter は created event と latest snapshot を1つの read-write transaction で atomic に保存しなければならない。

#### Scenario: Created aggregate
- **WHEN** `persistEventAndSnapshot(...)` が created event と matching aggregate で呼び出される
- **THEN** adapter は journal row を1件 insert する
- **THEN** adapter は `sequence_number = 0` かつ `version = 1` の latest snapshot row を insert する

### Requirement: Persist update event atomically
Spanner adapter は update event を保存し、latest snapshot version を1つの read-write transaction で atomic に進めなければならない。

#### Scenario: Event-only update
- **WHEN** `persistEvent(...)` が current expected version で呼び出される
- **THEN** adapter は journal row を1件 insert する
- **THEN** adapter は latest snapshot payload を置き換えずに latest snapshot version を increment する

### Requirement: Persist update event with snapshot atomically
Spanner adapter は snapshot が提供された場合、update event を保存し、latest snapshot payload を1つの read-write transaction で atomic に置き換えなければならない。

#### Scenario: Update with snapshot
- **WHEN** `persistEventAndSnapshot(...)` が update event と matching aggregate で呼び出される
- **THEN** adapter は journal row を1件 insert する
- **THEN** adapter は `sequence_number = 0` の latest snapshot row を new payload と incremented version で update する

### Requirement: Optimistic locking
Spanner adapter は既存の optimistic locking semantics を維持しなければならない。

#### Scenario: Unknown aggregate update
- **WHEN** `persistEvent(...)` が latest snapshot を持たない aggregate に対して呼び出される
- **THEN** adapter は `OptimisticLockError` で operation を拒否する

#### Scenario: Stale version
- **WHEN** latest snapshot version が expected version と異なる
- **THEN** adapter は `OptimisticLockError` で operation を拒否する

#### Scenario: Duplicate created event
- **WHEN** 既に存在する aggregate に対して created event が保存される
- **THEN** adapter は `OptimisticLockError` で operation を拒否する

#### Scenario: Duplicate journal row
- **WHEN** journal row の insert 時に Spanner が `ALREADY_EXISTS` を返す
- **THEN** adapter は failure を `OptimisticLockError` に変換する

### Requirement: Spanner transaction abort handling
Spanner adapter は transaction `ABORTED` の retry behavior を Spanner client に任せ、最終的な unrecovered abort を optimistic lock error として再分類してはならない。

#### Scenario: Transaction abort
- **WHEN** concurrency により Spanner が read-write transaction を abort する
- **THEN** adapter は Spanner client の transaction retry mechanism に処理させる
- **THEN** 最終的に残った unrecovered abort は `OptimisticLockError` に変換せず伝播する

### Requirement: Event timestamps
Spanner adapter は timestamp columns に domain event time を保存しなければならない。

#### Scenario: Store event time
- **WHEN** event が journal に書き込まれる
- **THEN** `journal.occurred_at` は `event.occurredAt` を保存する
- **WHEN** event によって latest snapshot または retained snapshot が write / update される
- **THEN** `snapshot.updated_at` は同じ `event.occurredAt` を保存する

### Requirement: Event replay reads
Spanner adapter は1つの aggregate の event を指定 sequence number 以降、sequence number 昇順で読み取らなければならない。

#### Scenario: Read events since sequence number
- **WHEN** `getEventsByIdSinceSequenceNumber(id, sequenceNumber)` が呼び出される
- **THEN** adapter はその aggregate のうち、指定値以上の sequence number を持つ event を返す
- **THEN** event は sequence number ascending で並ぶ

### Requirement: Latest snapshot reads
Spanner adapter は `sequence_number = 0` の snapshot row から latest snapshot を読み取らなければならない。

#### Scenario: Read latest snapshot
- **WHEN** `getLatestSnapshotById(id)` が existing aggregate に対して呼び出される
- **THEN** adapter は stored version を適用した deserialized snapshot を返す

#### Scenario: Missing latest snapshot
- **WHEN** `getLatestSnapshotById(id)` が unknown aggregate に対して呼び出される
- **THEN** adapter は `undefined` を返す

### Requirement: Retained snapshot copies
Spanner adapter は `keepSnapshotCount` が configured の場合、retained snapshot copy を書き込まなければならない。

#### Scenario: Retained snapshot write
- **WHEN** `persistEventAndSnapshot(...)` が snapshot を書き込み、`keepSnapshotCount` が configured である
- **THEN** adapter は `sequence_number = event.sequenceNumber` の retained snapshot row を書き込む

### Requirement: Snapshot retention hard deletion
Spanner adapter は `keepSnapshotCount` を超過した retained snapshot copies を hard-delete しなければならない。

#### Scenario: Delete excess retained snapshots
- **WHEN** aggregate の retained snapshot count が `keepSnapshotCount` を超える
- **THEN** adapter は古い retained snapshots を削除し、最新の retained snapshots を残す

### Requirement: Change Streams out of scope
初期の Spanner adapter は Change Streams を作成または管理してはならない。

#### Scenario: Downstream integration guidance
- **WHEN** documentation が将来の Change Streams integration に触れる
- **THEN** `snapshot` ではなく `journal` を監視対象にするべきだと明記する
