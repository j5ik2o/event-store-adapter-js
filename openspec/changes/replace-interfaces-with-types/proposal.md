## なぜ

現在のライブラリは、ストレージ非依存の契約を TypeScript の構造的型として公開している。一方で、一部の公開契約はまだ `interface` で定義され、サンプルもクラスに依存している。そのため、本来は構造で満たせる契約が名目的な契約に見えやすく、利用例にも `instanceof` ベースのドメインモデリングが残っている。

加えて、ファクトリ名が自由関数の `createX(...)` と `EventStore.ofX(...)` に分かれている。今回の変更では、Scala のコンパニオンオブジェクトに近い `UserAccountId.create(...)` のような同名ファクトリオブジェクトへ揃える。

## 何を変えるか

- 構造的な公開契約を、エクスポートされた `interface` から型エイリアスへ置き換える。
- 本ライブラリが定義しているクラスを、製品コード、サンプル、ライブラリ内テスト用データから取り除き、不変オブジェクト値、型エイリアス、ファクトリオブジェクトへ置き換える。
- `OptimisticLockError` は、呼び出し側が `instanceof OptimisticLockError` を使う可能性があるため、唯一の本ライブラリ定義クラス例外として残す。
- 外部 SDK 由来のクラスは対象外にする。
- ライブラリ内テスト用データとサンプルを、クラスを使わない集約 / イベント / 集約 ID モデリングへ更新し、Scala 風の不変値スタイルを示す。
- サンプルのイベント分岐を `instanceof` ではなく、`typeName` のような判別用データで行う。
- 公開ファクトリ関数 / メソッドを、同名ファクトリオブジェクトの `create` メソッドへ揃える。
- **破壊的変更**: `EventStore.ofDynamoDB(...)`、`EventStore.ofMemory(...)`、`EventStore.ofSpanner(...)` を `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)` へ置き換える。
- **破壊的変更**: `createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` を `AggregateIdValue.create(...)`、`ShardId.create(...)`、`ShardCount.create(...)` へ置き換える。
- **破壊的変更**: 旧ファクトリ名の互換用置き換えは提供しない。
- **破壊的変更**: エクスポートされた `interface` に対する宣言マージはサポート対象外にする。

## 能力

### 新規能力

- `type-based-contracts`: 構造的な公開契約を型エイリアスとして定義し、明示的なランタイムエラー識別子を除いて本ライブラリ定義クラスを廃止し、ファクトリを同名 `create` オブジェクトへ統一する。

### 変更される能力

- なし。

## 影響

- 公開 API: `Aggregate`、`AggregateId`、`Event`、`EventStore`、入力契約、シリアライザ、ロガー、シャードセレクタは同じ型名でエクスポートし続けるが、該当するものは型エイリアスになる。
- ランタイム API: `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)`、`AggregateIdValue.create(...)`、`ShardId.create(...)`、`ShardCount.create(...)`、`OptimisticLockError`。
- サンプル / テスト: ドメイン用データはクラスベースの `implements` / `instanceof` パターンから、不変なファクトリ生成値へ移行する。
- ドキュメント: README のサンプルは、ライブラリがクラスを要求していない箇所ではクラスではなく不変オブジェクト値と同名ファクトリオブジェクトを示す。
