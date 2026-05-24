## 背景

現在の package は pre-release の TypeScript library であり、domain-facing API はすでに構造的型として扱われている。呼び出し側は `Aggregate`、`AggregateId`、`Event`、`EventStore`、serializers、input contracts、extension points を type として import する。一方で、これらの contract の一部は `interface` として定義されており、examples では aggregate、id、event を class と `instanceof` dispatch で表現している。

これにより次の問題がある。

- type-only contract であるにもかかわらず、nominal な契約に見えやすい。
- serialized event は storage boundary を越えるため、本来は `typeName` のような安定した data で判定する方が自然だが、example code が runtime class identity を教えている。
- factory naming が free function の `createX(...)` と `EventStore.ofX(...)` に分かれている。目指すモデルは `UserAccountId.create(...)` のような same-name factory object である。

ただし、runtime value として残すべきものもある。`EventStore` は type name であると同時に frozen constructor object であり、`OptimisticLockError` は `instanceof` で使われうる public error class である。

## 目的 / 対象外

**目的:**

- 構造的な public contract を `interface` ではなく `type` alias として定義する。
- `import type { EventStore }` などの type import が動くよう、export 名は維持する。
- `EventStore` runtime factory object は維持しつつ、construction method を `createDynamoDB`、`createMemory`、`createSpanner` へ rename する。
- `createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` を same-name factory object の `AggregateIdValue.create(...)`、`ShardId.create(...)`、`ShardCount.create(...)` へ置き換える。
- `OptimisticLockError` の public error identity は維持する。
- production code、examples、library test fixtures から、`OptimisticLockError` を除く library-authored class を取り除く。
- examples と internal fixtures を、class-based domain object と `instanceof` event dispatch から移行する。
- class を置き換える際は、Scala 風の immutable value style に寄せ、object factory と immutable copy を優先する。
- 既存の EventStore behavior、storage schema、persistence semantics は変えない。

**対象外:**

- 関数型プログラミング framework や新しい runtime dependency は導入しない。
- 旧 factory 名の compatibility shim は提供しない。
- DynamoDB、memory、Spanner の storage behavior は変えない。
- 別の error contract を提案しない限り、`OptimisticLockError` class は削除しない。
- AWS SDK、Google Cloud Spanner、testcontainers など外部 SDK 由来の class は削除対象にしない。
- declaration merging の compatibility shim は追加しない。

## 判断

### Public interface を object-shaped type alias へ変換する

`Aggregate`、`AggregateId`、`Event`、input contracts、serializer contracts、`Logger`、`ShardSelector`、`EventStore` type などの public contract は、`interface` declaration から object shape を持つ `type` alias へ変換する。

これにより structural typing であることを明示しつつ、type import 名は維持できる。既知の breaking point は declaration merging である。これらの contract は user-augmented な ambient extension point ではなく、library が閉じて定義する契約として扱うため、pre-release cleanup として許容する。

代替案として、interface を残して examples だけ変える案がある。この案は差分を小さくできるが、source code 上は不要な extensible interface model を伝え続けてしまう。

### EventStore は same-name type / runtime value を維持しつつ factory を createX へ rename する

`EventStore` は次の2つを兼ねる。

- persistence contract を表す type alias
- `createDynamoDB`、`createMemory`、`createSpanner` を持つ frozen runtime object

runtime object は単一の public construction boundary として残す。ただし factory method 名は、`UserAccountId.create(...)`、`ShardId.create(...)`、`AggregateIdValue.create(...)` のような value factory と揃えるため `create` に寄せる。同じ file で type と runtime value の両方を使う場合は、`import type` を明示する。

代替案として、`EventStore.ofX(...)` だけを例外として残す案がある。この案は call-site の変更量を減らせるが、「factory vocabulary を1つにする」というルールを弱め、不要な naming split を残してしまう。

### Public value factory を same-name create object にする

Public value factory は same-name runtime object へ移行する。

- `AggregateIdValue.create(value)`
- `ShardId.create(value)`
- `ShardCount.create(value)`

従来の free function は shim なしで削除する。これは breaking change だが、二重 API を避け、新しい domain examples と public API style を揃えられる。

代替案として、`createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` を deprecated alias として残す案がある。この案は migration を楽にするが、pre-release cleanup において2つの construction path を同時に残してしまう。

### 明示的な runtime identity を除いて library-authored class を削除する

Production code、examples、library test fixtures では library-authored class を使わない。例外は `OptimisticLockError` のような public runtime error identity のみとする。外部 SDK class は対象外である。

Internal store implementation は class から factory function または closure-backed object へ移行する。対象には internal `MemoryEventStore`、`DynamoDBEventStore`、`SpannerEventStore`、aggregate key helpers、default serializers、shard selectors、test fakes を含める。

Public な `EventStore.createX(...)` methods が construction boundary であるため、呼び出し側は返された object が class 由来か closure 由来かを観測しない。

代替案として、public type declaration だけを変換し、internal class は残す案がある。この案は差分を小さくできるが、「class をやめる」という目的を部分的にしか満たさず、test fixtures に古い style が残る。

### OptimisticLockError は public runtime class として残す

`OptimisticLockError` は `Error` を継承する class として残す。既存の呼び出し側は `error instanceof OptimisticLockError` で分岐している可能性があり、これを type alias や tagged object に置き換えると、この cleanup の範囲を超える runtime breaking change になる。

identity が観測されない internal custom error class は、通常の `Error` を返す helper などへ置き換える。

代替案として、すべての error class を tagged error に置き換える案がある。この案は class をさらに減らせるが、現在 export されている中で最も重要な runtime identity を壊す。

### Immutable value と localized mutation を使う

Public domain values と API objects は immutable とする。Domain examples は type alias と same-name factory object を使い、更新操作は既存 value を mutate せず新しい value を返す。`withVersion(...)` と `updateVersion(...)` は既存 aggregate contract の一部なので残すが、実装は mutable な `this` state に依存しない。

Persistence adapter internals では、既存の async persistence contract を実装するために必要で、外部から観測できない場合に限り localized mutation を許容する。たとえば in-memory store は closure-owned な `Map` を mutate してよいが、seed input は defensive copy し、外部に返す API object は immutable にする。

代替案として、すべての persistence operation が新しい store value を返す設計がある。この案はより純粋だが、既存の side-effecting な `EventStore` persistence contract を変えてしまう。

### Aggregate behavior は immutable object 上に残す

`Aggregate` contract には `withVersion(...)` と `updateVersion(...)` が含まれているため、aggregate value は method を持つ immutable object として残す。Event value は data-only とし、aggregate id value は既存 contract の `asString()` method を残す。Method は closure または helper で実装し、rebinding-sensitive な `this` behavior を避ける。

代替案として、すべての behavior を free function へ移す案がある。この案は pure data plus functions に近いが、今回の cleanup より広い public contract change になる。

### Example では instanceof ではなく discriminated event data を使う

Example events は、stable literal `typeName` を持つ object-shaped value にする。Replay / apply logic は `event instanceof SomeClass` ではなく `event.typeName` で分岐する。

これは serialization boundary と整合する。Persistence round trip 後の event identity は constructor ではなく data に基づくべきである。

代替案として、event class を残して static factory function だけを使う案がある。この案は class identity を primary domain pattern として教え続けてしまう。

## リスク / トレードオフ

- [declaration merging に依存している利用者が extension point を失う] -> pre-release の intentional breaking change として proposal と release note に明記する。
- [旧 factory 名に依存している call site の更新が必要になる] -> shim は提供せず、README、examples、tests を更新し、完了前に旧名が残っていないことを検索する。
- [same-name の `EventStore` type/value が編集時に紛らわしい] -> `import type` を一貫して使い、constructor object type は private に保つ。
- [class-to-object rewrite で `this` behavior が変わる] -> rebinding に依存する method ではなく、closure-based function と object factory helper を優先する。
- [event dispatch の変更で exhaustive check が抜ける] -> literal `typeName` を持つ discriminated union と `never` exhaustive check を使う。
- [internal tests が implementation class を直接 instantiate している可能性がある] -> 可能な限り `EventStore.createX(...)` または internal factory helper 経由にし、storage contract tests は維持する。
- [in-memory store の seed data から localized mutation が漏れる] -> input boundary で defensive copy を続け、mutable state は closure 内に閉じ込める。
