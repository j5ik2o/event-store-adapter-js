## ADDED Requirements

### Requirement: 構造的契約は type alias で定義する

ライブラリは、エクスポートされる構造的契約を TypeScript の `interface` 宣言ではなく `type` alias として定義する。

#### Scenario: 型だけの公開契約 import が維持される

- **WHEN** 呼び出し側が `Aggregate`、`AggregateId`、`Event`、`EventStore`、シリアライザ契約、入力契約、`Logger`、`ShardSelector` を `import type` で取り込む
- **THEN** 取り込んだ名前は、同じエクスポート名の型として利用できる

#### Scenario: プレーンオブジェクトが公開契約を満たす

- **WHEN** 呼び出し側が `Aggregate`、`AggregateId`、`Event`、`EventStore` の形状を満たすプレーンオブジェクトを作る
- **THEN** TypeScript は `class` 宣言や `implements` 句を要求せず、その値を受け入れる

#### Scenario: 宣言マージはサポートしない

- **WHEN** 呼び出し側が公開構造契約を TypeScript の `interface` 宣言マージで拡張しようとする
- **THEN** ライブラリはその拡張を公開互換契約としてサポートしない

### Requirement: ランタイム API 値は明示的に残す

ライブラリは、呼び出し側が JavaScript ランタイム値として必要とするものだけをランタイム値として公開する。

#### Scenario: EventStore create ファクトリが利用できる

- **WHEN** 呼び出し側が `EventStore` をランタイム値として取り込む
- **THEN** `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)` は既存の EventStore 構築挙動と同等の動作で利用できる

#### Scenario: 古い EventStore ファクトリ名は削除される

- **WHEN** 呼び出し側が `EventStore` をランタイム値として取り込む
- **THEN** `EventStore.ofDynamoDB(...)`、`EventStore.ofMemory(...)`、`EventStore.ofSpanner(...)` は公開 API に含まれない

#### Scenario: Result ファクトリが利用できる

- **WHEN** 呼び出し側が回復可能な EventStore 操作結果を扱う
- **THEN** `Result.ok(...)` と `Result.err(...)` は値を構築するランタイムファクトリとして利用できる

#### Scenario: EventStoreError ファクトリが利用できる

- **WHEN** ライブラリが楽観ロック失敗などの回復可能な失敗を返す
- **THEN** `EventStoreError` のファクトリは `type` フィールドを持つ判別共用体の値を構築する

### Requirement: 同名値ファクトリは create を使う

ライブラリは、値の構築を同名ランタイムファクトリオブジェクトの `create` メソッドとして公開する。

#### Scenario: ShardId を構築する

- **WHEN** 呼び出し側がシャード ID を構築する
- **THEN** 呼び出し側は `ShardId.create(...)` を使う

#### Scenario: ShardCount を構築する

- **WHEN** 呼び出し側がシャード数を構築する
- **THEN** 呼び出し側は `ShardCount.create(...)` を使う

#### Scenario: 古い自由ファクトリ名は削除される

- **WHEN** 呼び出し側がライブラリのランタイム値を取り込む
- **THEN** `createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` は公開 API に含まれない

#### Scenario: ライブラリ所有の集約 ID 値型は削除される

- **WHEN** 呼び出し側が `AggregateId` を実装または構築する
- **THEN** `AggregateId.value` はライブラリ固有の `AggregateIdValue` ではなく plain `string` として扱える
- **AND** `AggregateIdValue` は公開型として提供されない

#### Scenario: 集約 ID の具象生成は利用側が所有する

- **WHEN** 呼び出し側が集約 ID を構築する
- **THEN** ライブラリは `AggregateIdValue.create(...)` のような具象集約 ID 値ファクトリを提供しない
- **AND** 呼び出し側はユーザー側コードの `UserAccountId.create(...)` のようなドメイン固有 AID ファクトリで集約 ID を構築する

### Requirement: 回復可能なエラーは Result と判別共用体で返す

ライブラリは、楽観ロック失敗など契約上想定される回復可能な失敗を例外として投げず、`Result` と `EventStoreError` の判別共用体で返す。

#### Scenario: 楽観ロック失敗は Result の err で返す

- **WHEN** EventStore 操作が楽観ロック失敗に到達する
- **THEN** 呼び出し側は `throw` された `OptimisticLockError` ではなく、`Result` の `err` 側を受け取る

#### Scenario: 呼び出し側はエラー type で分岐する

- **WHEN** 呼び出し側が EventStore 操作の失敗理由を判定する
- **THEN** 呼び出し側は `instanceof` ではなく `result.error.type` の文字列リテラルで分岐できる

#### Scenario: 旧 OptimisticLockError クラスは公開 API に含まれない

- **WHEN** 呼び出し側がライブラリのランタイム値を取り込む
- **THEN** `OptimisticLockError` は公開 `Error` サブクラスとして提供されない

### Requirement: 本ライブラリ定義クラスを使わない

ライブラリは、製品コード、サンプル、ライブラリ内テスト用データで本ライブラリ定義クラスを使わない。

#### Scenario: 内部実装は `class` を避ける

- **WHEN** 製品コード、サンプル、ライブラリ内テスト用データが本ライブラリ定義ランタイム構造を定義する
- **THEN** それらの構造は `class` ではなく、型エイリアス、不変オブジェクト値、ファクトリオブジェクト、または関数を使う

#### Scenario: 外部 SDK クラスは対象外にする

- **WHEN** コードが外部 SDK やツールが提供する値を構築する
- **THEN** このクラス制限はそれらの外部クラスには適用されない

### Requirement: イベント分岐はデータで判別する

サンプルとテスト用ドメインイベントは、JavaScript コンストラクタ識別子ではなく、安定したイベントデータを使って挙動を選択する。

#### Scenario: リプレイはイベント typeName を使う

- **WHEN** サンプルまたはテスト用データのリプレイコードが保存済みドメインイベントを適用する
- **THEN** `typeName` のような判別用イベントデータを使って挙動を選択する

#### Scenario: リプレイは instanceof に依存しない

- **WHEN** イベントがストレージからデシリアライズされ、構造的に互換なイベント値になっている
- **THEN** サンプルまたはテスト用データのリプレイコードは `event instanceof SomeEventClass` を要求せずに処理できる

### Requirement: サンプルは runtime brand と JSON 復元を示す

サンプルとライブラリ内テスト用データは、利用側が serializer converter を実装するときの pattern として、同名 factory namespace に runtime brand 判定と JSON 変換を持つ。

#### Scenario: factory 生成値は runtime brand で判定できる

- **WHEN** サンプルまたはテスト用データが `UserAccountId.create(...)`、イベント factory、集約 factory で値を構築する
- **THEN** 生成された値は module-private な `unique symbol` brand を持つ
- **AND** 同名 factory namespace の `is(value)` はその値を `true` と判定する

#### Scenario: 構造だけを真似た値は branded value として扱わない

- **WHEN** 呼び出し側が `typeName`、`value`、`asString()` などの構造だけを満たす plain object を渡す
- **THEN** 同名 factory namespace の `is(value)` は runtime symbol brand がないため `false` と判定する
- **AND** イベントまたは集約 factory は branded `AggregateId` を要求する入力ではその値を拒否する

#### Scenario: JSON 変換は toJSON と fromJSON を対にする

- **WHEN** サンプルまたはテスト用データが集約 ID、イベント、集約を JSON-safe な値に変換する
- **THEN** 同名 factory namespace は `toJSON(value)` を提供する
- **AND** `toJSON(value)` の返却値は `typeName` または `{ type, data }` wrapper によって復元先を判別できる

#### Scenario: JSON 復元は brand を再付与する

- **WHEN** サンプルまたはテスト用データが JSON-safe な plain object を復元する
- **THEN** 同名 factory namespace の `fromJSON(json)` は JSON shape を検証する
- **AND** `fromJSON(json)` は必ず `create(...)` 経由で runtime symbol brand を再付与した値を返す

#### Scenario: JSON.stringify 後の値は brand を失う

- **WHEN** 呼び出し側が runtime symbol brand を持つサンプル値を `JSON.stringify(...)` し、`JSON.parse(...)` で復元する
- **THEN** parse 直後の plain object は `is(value)` で `false` と判定される
- **AND** `fromJSON(...)` を通した後の値は `is(value)` で `true` と判定される

#### Scenario: 既存 converter 名は薄い alias として残る

- **WHEN** 既存サンプルまたはテストが `convertJSONToUserAccountId`、`convertJSONToUserAccountEvent`、`convertJSONToUserAccount` を呼ぶ
- **THEN** それらの関数は対応する `fromJSON(...)` を呼ぶ薄い alias として利用できる

#### Scenario: ライブラリ serializer API は変更しない

- **WHEN** 呼び出し側が `EventSerializer` または `SnapshotSerializer` を実装する
- **THEN** ライブラリは既存の `serialize(...)` と `deserialize(bytes, converter)` 契約を維持する
- **AND** 呼び出し側は `converter` 内で `fromJSON(...)` 相当の parse/factory を呼ぶことで branded domain value を復元できる

### Requirement: ストア構築は実装形状を隠す

ライブラリは、公開実装クラスではなくファクトリメソッドを通じて EventStore の構築を公開する。

#### Scenario: Memory ストアを構築する

- **WHEN** 呼び出し側がインメモリイベントストアを構築する
- **THEN** 呼び出し側は `EventStore.createMemory(...)` を使い、`EventStore` 型を満たす値を受け取る

#### Scenario: DynamoDB ストアを構築する

- **WHEN** 呼び出し側が DynamoDB イベントストアを構築する
- **THEN** 呼び出し側は `EventStore.createDynamoDB(...)` を使い、`EventStore` 型を満たす値を受け取る

#### Scenario: Spanner ストアを構築する

- **WHEN** 呼び出し側が Spanner イベントストアを構築する
- **THEN** 呼び出し側は `EventStore.createSpanner(...)` を使い、`EventStore` 型を満たす値を受け取る

### Requirement: 公開値は原則として不変にする

ライブラリは、公開ドメイン向け値と API オブジェクトを原則として不変値として扱う。

#### Scenario: 集約更新は新しい値を返す

- **WHEN** 集約値がバージョンまたはドメイン状態を更新する
- **THEN** 更新は既存値を変更せず、新しい集約値を返す

#### Scenario: API オブジェクトは外部から変更できない

- **WHEN** ライブラリが `EventStore` や値ファクトリオブジェクトのようなランタイム API オブジェクトを返す
- **THEN** 呼び出し側はサポート対象の使い方として公開 API オブジェクトのメソッド表を変更できない

#### Scenario: 永続化内部では局所的な変更を許容する

- **WHEN** アダプタが既存の非同期永続化契約を実装するために可変状態を必要とする
- **THEN** その変更はアダプタ内部に局所化され、呼び出し側から渡された可変オブジェクトを直接公開しない
