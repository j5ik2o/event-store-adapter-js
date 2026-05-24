## ADDED Requirements

### Requirement: 構造的契約は type alias で定義する

ライブラリは、export される構造的 contract を TypeScript の `interface` declaration ではなく `type` alias として定義する。

#### Scenario: Type-only public contract import が維持される

- **WHEN** 呼び出し側が `Aggregate`、`AggregateId`、`Event`、`EventStore`、serializer contracts、input contracts、`Logger`、`ShardSelector` を `import type` で import する
- **THEN** import した名前は、同じ export 名の type として利用できる

#### Scenario: Plain object が public contract を満たす

- **WHEN** 呼び出し側が `Aggregate`、`AggregateId`、`Event`、`EventStore` の shape を満たす plain object を作る
- **THEN** TypeScript は class declaration や `implements` clause を要求せず、その value を受け入れる

#### Scenario: Declaration merging はサポートしない

- **WHEN** 呼び出し側が public structural contract を TypeScript interface declaration merging で拡張しようとする
- **THEN** ライブラリはその拡張を public compatibility contract としてサポートしない

### Requirement: ランタイム API value は明示的に残す

ライブラリは、呼び出し側が JavaScript runtime value として必要とするものだけを runtime value として公開する。

#### Scenario: EventStore create factory が利用できる

- **WHEN** 呼び出し側が `EventStore` を runtime value として import する
- **THEN** `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)` は既存の EventStore construction behavior と同等の動作で利用できる

#### Scenario: 古い EventStore factory 名は削除される

- **WHEN** 呼び出し側が `EventStore` を runtime value として import する
- **THEN** `EventStore.ofDynamoDB(...)`、`EventStore.ofMemory(...)`、`EventStore.ofSpanner(...)` は public API に含まれない

#### Scenario: Optimistic lock error identity が利用できる

- **WHEN** 呼び出し側が optimistic locking failure を catch する
- **THEN** throw された error は `error instanceof OptimisticLockError` と互換である

### Requirement: Same-name value factories use create

ライブラリは、value construction を same-name runtime factory object の `create` method として公開する。

#### Scenario: AggregateIdValue を構築する

- **WHEN** 呼び出し側が aggregate id value を構築する
- **THEN** 呼び出し側は `AggregateIdValue.create(...)` を使う

#### Scenario: ShardId を構築する

- **WHEN** 呼び出し側が shard id を構築する
- **THEN** 呼び出し側は `ShardId.create(...)` を使う

#### Scenario: ShardCount を構築する

- **WHEN** 呼び出し側が shard count を構築する
- **THEN** 呼び出し側は `ShardCount.create(...)` を使う

#### Scenario: 古い free factory 名は削除される

- **WHEN** 呼び出し側が library runtime values を import する
- **THEN** `createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` は public API に含まれない

### Requirement: Library-authored classes are limited to error identity

ライブラリは、明示的な public runtime error identity を除き、production code、examples、library test fixtures で library-authored class を使わない。

#### Scenario: Public optimistic lock error は class のままにする

- **WHEN** 呼び出し側が `OptimisticLockError` を import する
- **THEN** `OptimisticLockError` は `instanceof` をサポートする runtime `Error` subclass のままである

#### Scenario: Internal implementation は class を避ける

- **WHEN** production code、examples、library test fixtures が library-authored runtime structures を定義する
- **THEN** それらの構造は `class` ではなく、type alias、immutable object value、factory object、または function を使う

#### Scenario: 外部 SDK class は対象外にする

- **WHEN** code が外部 SDK や tooling が提供する value を構築する
- **THEN** この class restriction はそれらの外部 class には適用されない

### Requirement: Event dispatch is data discriminated

Examples と test domain events は、JavaScript constructor identity ではなく、安定した event data を使って behavior を選択する。

#### Scenario: Replay は event typeName を使う

- **WHEN** example または fixture の replay code が stored domain event を apply する
- **THEN** `typeName` のような discriminated event data を使って behavior を選択する

#### Scenario: Replay は instanceof に依存しない

- **WHEN** event が storage から deserialized され、構造的に互換な event value になっている
- **THEN** example または fixture の replay code は `event instanceof SomeEventClass` を要求せずに処理できる

### Requirement: Store construction hides implementation shape

ライブラリは、public implementation class ではなく factory method を通じて EventStore construction を公開する。

#### Scenario: Memory store を構築する

- **WHEN** 呼び出し側が in-memory event store を構築する
- **THEN** 呼び出し側は `EventStore.createMemory(...)` を使い、`EventStore` type を満たす value を受け取る

#### Scenario: DynamoDB store を構築する

- **WHEN** 呼び出し側が DynamoDB event store を構築する
- **THEN** 呼び出し側は `EventStore.createDynamoDB(...)` を使い、`EventStore` type を満たす value を受け取る

#### Scenario: Spanner store を構築する

- **WHEN** 呼び出し側が Spanner event store を構築する
- **THEN** 呼び出し側は `EventStore.createSpanner(...)` を使い、`EventStore` type を満たす value を受け取る

### Requirement: Public values are immutable by default

ライブラリは、public domain-facing values と API objects を原則として immutable value として扱う。

#### Scenario: Aggregate update は新しい value を返す

- **WHEN** aggregate value が version または domain state を更新する
- **THEN** 更新は既存 value を mutate せず、新しい aggregate value を返す

#### Scenario: API object は外部から mutate できない

- **WHEN** ライブラリが `EventStore` や value factory object のような runtime API object を返す
- **THEN** 呼び出し側は supported usage として public API object の method table を mutate できない

#### Scenario: Persistence internals では localized mutation を許容する

- **WHEN** adapter が既存の asynchronous persistence contract を実装するために mutable state を必要とする
- **THEN** その mutation は adapter 内部に局所化され、呼び出し側から渡された mutable object を直接 expose しない
