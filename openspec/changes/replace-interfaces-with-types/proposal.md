## なぜ

現在のライブラリは storage-neutral な契約を TypeScript の構造的型として公開しているが、一部の public contract はまだ `interface` で定義され、examples も class に依存している。そのため、本来は構造的に扱える契約が nominal な契約に見えやすく、documented path に `instanceof` ベースのドメインモデリングも残っている。

加えて、factory naming が free function の `createX(...)` と `EventStore.ofX(...)` に分かれている。今回の変更では、Scala の companion object に近い `UserAccountId.create(...)` のような same-name factory object へ揃える。

## 何を変えるか

- 構造的な public contract を、export された `interface` から `type` alias へ置き換える。
- production code、examples、library test fixtures にある library-authored class を、immutable object value、type alias、factory object へ置き換える。
- `OptimisticLockError` は、呼び出し側が `instanceof OptimisticLockError` を使う可能性があるため、唯一の library-authored class 例外として残す。
- 外部 SDK 由来の class は対象外にする。
- internal test fixtures と examples を、class-free な aggregate / event / aggregate id modeling に更新し、Scala 風の immutable value style を示す。
- example の event dispatch を `instanceof` ではなく、`typeName` のような discriminated data で行う。
- public factory function / method を、same-name factory object の `create` method へ揃える。
- **BREAKING**: `EventStore.ofDynamoDB(...)`、`EventStore.ofMemory(...)`、`EventStore.ofSpanner(...)` を `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)` へ置き換える。
- **BREAKING**: `createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` を `AggregateIdValue.create(...)`、`ShardId.create(...)`、`ShardCount.create(...)` へ置き換える。
- **BREAKING**: 旧 factory 名の compatibility shim は提供しない。
- **BREAKING**: export された interface に対する declaration merging はサポート対象外にする。

## Capabilities

### New Capabilities

- `type-based-contracts`: 構造的な public contract を `type` alias として定義し、明示的な runtime error identity を除いて library-authored class を廃止し、factory を same-name `create` object へ統一する。

### Modified Capabilities

- なし。

## 影響

- Public API: `Aggregate`、`AggregateId`、`Event`、`EventStore`、input contracts、serializers、logger、shard selector は同じ type 名で export し続けるが、該当するものは `type` alias になる。
- ランタイム API: `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)`、`AggregateIdValue.create(...)`、`ShardId.create(...)`、`ShardCount.create(...)`、`OptimisticLockError`。
- Examples / tests: domain fixtures は class-based な `implements` / `instanceof` pattern から、immutable な factory-created value へ移行する。
- ドキュメント: README examples は、ライブラリが class を要求していない箇所では class ではなく immutable object value と same-name factory object を示す。
