## ADDED Requirements

### Requirement: Spanner EventStore construction
MUST: `EventStore.ofSpanner(...)` から Cloud Spanner 用 `EventStore` adapter を構築できること。
システムは `EventStore.ofSpanner(...)` から Cloud Spanner 用 `EventStore` adapter を公開しなければならない。

#### Scenario: Construct Spanner EventStore
- **WHEN** 呼び出し側が valid な `SpannerEventStoreInput` を渡す
- **THEN** `EventStore.ofSpanner(...)` は、渡された Spanner `Database` を使う `EventStore` implementation を返す

### Requirement: Caller-managed Spanner database
MUST: Spanner `Database` のライフサイクルは呼び出し側が管理すること。
Spanner adapter は caller-managed Spanner `Database` を受け取らなければならず、内部で Spanner client を作成または close してはならない。

#### Scenario: Use provided Database
- **WHEN** Spanner EventStore が作成される
- **THEN** すべての read、write、transaction は `SpannerEventStoreInput` の `Database` を使う

### Requirement: Shard value object
MUST: Spanner shard identity と shard count は public value object と selector で表現すること。
システムは `ShardId` / `ShardCount` value object と、検証済み `ShardCount` を受け取り `ShardId` を返す共通 `ShardSelector` を提供しなければならない。

#### Scenario: Select shard for aggregate
- **WHEN** Spanner adapter が aggregate ID の row key を組み立てる
- **THEN** `ShardCount` に parse 済みの shard count を `ShardSelector.selectShardId(...)` に渡して `ShardId` を取得する
- **THEN** SQL boundary で parameter に変換するまでは aggregate identity を `AggregateId` として保持する

### Requirement: Valid shard configuration
MUST: invalid な shard count は Spanner EventStore construction 時に拒否すること。
Spanner adapter は shard selection に使う前に invalid な shard count を拒否しなければならない。

#### Scenario: Invalid shard count
- **WHEN** `SpannerEventStoreInput.shardCount` が positive integer ではない
- **THEN** Spanner EventStore construction は configuration error で失敗する

### Requirement: GoogleSQL schema
MUST: Spanner 用 GoogleSQL schema をドキュメント化すること。
Spanner adapter は shard ID、aggregate ID、sequence number、payload、event timestamp 向け typed columns を使った GoogleSQL の `journal` / `snapshot` table をドキュメント化しなければならない。

#### Scenario: Schema documentation
- **WHEN** ユーザーが Spanner schema documentation を読む
- **THEN** `journal` は primary key `(shard_id, aggregate_id, sequence_number)` として定義されている
- **THEN** `snapshot` は primary key `(shard_id, aggregate_id, sequence_number)` として定義されている

### Requirement: Serializer-compatible payload storage
MUST: event / snapshot payload は configured serializer が生成した bytes として保存すること。
Spanner adapter は configured serializer が生成した bytes として event / snapshot payload を保存しなければならない。

#### Scenario: Persist and read payload
- **WHEN** event または snapshot が Spanner に書き込まれる
- **THEN** adapter は serializer-produced bytes を `BYTES(MAX)` payload column に保存する
- **WHEN** その値が読み取られる
- **THEN** adapter は configured serializer と converter を使って deserialize する

### Requirement: Persist created event and latest snapshot atomically
MUST: created event と latest snapshot は1つの read-write transaction で atomic に保存すること。
Spanner adapter は created event、latest snapshot、configured retained snapshot copy を1つの read-write transaction で atomic に保存しなければならない。

#### Scenario: Created aggregate
- **WHEN** `persistEventAndSnapshot(...)` が created event と matching aggregate で呼び出される
- **THEN** adapter は journal row を1件 insert する
- **THEN** adapter は `sequence_number = 0` かつ `version = 1` の latest snapshot row を insert する
- **THEN** `keepSnapshotCount` が configured の場合、adapter は同じ transaction で `sequence_number = event.sequenceNumber` の retained snapshot row を insert する

### Requirement: Persist update event atomically
MUST: update event 保存と latest snapshot version 更新は1つの read-write transaction で atomic に行うこと。
Spanner adapter は update event を保存し、latest snapshot version を1つの read-write transaction で atomic に進めなければならない。

#### Scenario: Event-only update
- **WHEN** `persistEvent(...)` が current expected version で呼び出される
- **THEN** adapter は journal row を1件 insert する
- **THEN** adapter は latest snapshot payload を置き換えずに latest snapshot version を increment する

### Requirement: Persist update event with snapshot atomically
MUST: update event と snapshot payload 更新は1つの read-write transaction で atomic に保存すること。
Spanner adapter は snapshot が提供された場合、update event、latest snapshot payload、configured retained snapshot copy を1つの read-write transaction で atomic に保存しなければならない。

#### Scenario: Update with snapshot
- **WHEN** `persistEventAndSnapshot(...)` が update event と matching aggregate で呼び出される
- **THEN** adapter は journal row を1件 insert する
- **THEN** adapter は `sequence_number = 0` の latest snapshot row を new payload と incremented version で update する
- **THEN** `keepSnapshotCount` が configured の場合、adapter は同じ transaction で `sequence_number = event.sequenceNumber` の retained snapshot row を insert する

### Requirement: Optimistic locking
MUST: Spanner adapter は既存 adapter と同じ optimistic locking semantics を維持すること。
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
MUST: transaction `ABORTED` は Spanner client の retry behavior に委ねること。
Spanner adapter は transaction `ABORTED` の retry behavior を Spanner client に任せ、最終的な unrecovered abort を optimistic lock error として再分類してはならない。

#### Scenario: Transaction abort
- **WHEN** concurrency により Spanner が read-write transaction を abort する
- **THEN** adapter は Spanner client の transaction retry mechanism に処理させる
- **THEN** 最終的に残った unrecovered abort は `OptimisticLockError` に変換せず伝播する

### Requirement: Event timestamps
MUST: timestamp columns には wall-clock 書き込み時刻ではなく domain event time を保存すること。
Spanner adapter は timestamp columns に domain event time を保存しなければならない。

#### Scenario: Store event time
- **WHEN** event が journal に書き込まれる
- **THEN** `journal.occurred_at` は `event.occurredAt` を保存する
- **WHEN** event によって latest snapshot または retained snapshot が write / update される
- **THEN** `snapshot.updated_at` は同じ `event.occurredAt` を保存する

### Requirement: Event replay reads
MUST: event replay reads は aggregate 単位で指定 sequence number 以降を ascending order で返すこと。
Spanner adapter は1つの aggregate の event を指定 sequence number 以降、sequence number 昇順で読み取らなければならない。

#### Scenario: Read events since sequence number
- **WHEN** `getEventsByIdSinceSequenceNumber(id, sequenceNumber)` が呼び出される
- **THEN** adapter はその aggregate のうち、指定値以上の sequence number を持つ event を返す
- **THEN** event は sequence number ascending で並ぶ

### Requirement: Latest snapshot reads
MUST: latest snapshot reads は `sequence_number = 0` の snapshot row を使うこと。
Spanner adapter は `sequence_number = 0` の snapshot row から latest snapshot を読み取らなければならない。

#### Scenario: Read latest snapshot
- **WHEN** `getLatestSnapshotById(id)` が existing aggregate に対して呼び出される
- **THEN** adapter は stored version を適用した deserialized snapshot を返す

#### Scenario: Missing latest snapshot
- **WHEN** `getLatestSnapshotById(id)` が unknown aggregate に対して呼び出される
- **THEN** adapter は `undefined` を返す

### Requirement: Retained snapshot copies
MUST: `keepSnapshotCount` configured 時は retained snapshot copy を書き込むこと。
Spanner adapter は `keepSnapshotCount` が configured の場合、retained snapshot copy を書き込まなければならない。

#### Scenario: Retained snapshot write
- **WHEN** `persistEventAndSnapshot(...)` が snapshot を書き込み、`keepSnapshotCount` が configured である
- **THEN** adapter は `sequence_number = event.sequenceNumber` の retained snapshot row を書き込む

### Requirement: Snapshot retention hard deletion
MUST: Spanner snapshot retention は retained snapshot copies だけを hard-delete すること。
Spanner adapter は `sequence_number > 0` の retained snapshot copies だけを retention 対象とし、`keepSnapshotCount` を超過した retained snapshot copies を hard-delete しなければならない。`sequence_number = 0` の latest snapshot は retention count に含めてはならず、retention による削除対象にしてはならない。

#### Scenario: Delete excess retained snapshots
- **WHEN** aggregate の retained snapshot count が `keepSnapshotCount` を超える
- **THEN** adapter は retained snapshots を `sequence_number` descending で並べた最新 `keepSnapshotCount` 件を残す
- **THEN** adapter はそれ以外の retained snapshots を削除する

### Requirement: Change Streams out of scope
MUST: 初期 Spanner adapter は Change Streams を作成または管理しないこと。
初期の Spanner adapter は Change Streams を作成または管理してはならない。

#### Scenario: Downstream integration guidance
- **WHEN** documentation が将来の Change Streams integration に触れる
- **THEN** `snapshot` ではなく `journal` を監視対象にするべきだと明記する
