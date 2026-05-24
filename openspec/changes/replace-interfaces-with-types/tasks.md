## 1. Public Type Contracts の整理

- [ ] 1.1 `Aggregate`、`AggregateId`、`Event`、`EventStore`、input contracts、serializers、`Logger`、`ShardSelector` を、`interface` declaration から object-shaped な `type` alias へ変換する。
- [ ] 1.2 `src/index.ts` と `src/types.ts` から export される既存の type 名を維持する。
- [ ] 1.3 same-name の `EventStore` runtime factory object を維持し、construction method を `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)` へ rename する。
- [ ] 1.4 `createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` を `AggregateIdValue.create(...)`、`ShardId.create(...)`、`ShardCount.create(...)` へ置き換える。
- [ ] 1.5 旧 factory 名を compatibility shim なしで削除する。
- [ ] 1.6 plain object value が class declaration なしで `Aggregate`、`AggregateId`、`Event`、`EventStore` を満たすことを確認する type-level test を追加または更新する。

## 2. Class-Free Runtime Implementation への移行

- [ ] 2.1 internal EventStore implementation class を factory function または closure-backed object へ置き換える。
- [ ] 2.2 aggregate keys、default serializers、shard selectors、private error classes、test fakes などの internal helper class を、type alias、object factory、または function へ置き換える。
- [ ] 2.3 `OptimisticLockError` は public `Error` subclass として残し、`instanceof OptimisticLockError` behavior を維持する。
- [ ] 2.4 tests が implementation class を直接 construct しなくてよいよう、internal construction を `EventStore.createX(...)` または internal factory helper 経由にする。
- [ ] 2.5 public API object は freeze するか、サポート対象の呼び出し方では mutate できない形にする。
- [ ] 2.6 adapter-local mutable state は closure 内に隔離し、呼び出し側から渡された mutable seed data は defensive copy する。

## 3. Examples とドキュメントの更新

- [ ] 3.1 example の aggregate id、event、aggregate model を、type alias、same-name factory object、immutable object value として書き換える。
- [ ] 3.2 example の `instanceof` event dispatch を、`typeName` のような stable event data に基づく discriminated handling へ置き換える。
- [ ] 3.3 README examples を更新し、ライブラリが structural value だけを要求する箇所では class ではなく immutable object value と same-name factory object を示す。
- [ ] 3.4 interface declaration merging が compatibility contract の対象外になる intentional breaking change を document する。
- [ ] 3.5 旧 factory 名から `create` method への intentional breaking change を document する。

## 4. 検証

- [ ] 4.1 library と examples の formatter / lint を実行する。
- [ ] 4.2 library build を実行し、生成された declaration files が export 名を維持していることを確認する。
- [ ] 4.3 EventStore contract tests を含む relevant Jest test suites を実行する。
- [ ] 4.4 生成された `dist/*.d.ts` を確認し、runtime export の意図しない削除や type export の欠落がないことを確認する。
- [ ] 4.5 `rg "createShardId|createShardCount|createAggregateIdValue|ofMemory|ofDynamoDB|ofSpanner" packages` で旧 factory 名が残っていないことを確認する。
- [ ] 4.6 `OptimisticLockError` と外部 SDK usage を除き、library-authored class が残っていないことを確認する。
- [ ] 4.7 `replace-interfaces-with-types` の OpenSpec status を実行し、change が apply-ready のままであることを確認する。
