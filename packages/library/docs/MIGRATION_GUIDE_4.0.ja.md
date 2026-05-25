# 移行ガイド 4.0

4.0 は意図的な破壊的リリースです。`Aggregate`、`AggregateId`、`Event`、`EventStore` などの構造的な型名は維持しますが、ランタイム factory は同名 factory object に揃えます。

## EventStore factory

Before:

```ts
const store = EventStore.ofDynamoDB(input);
const memory = EventStore.ofMemory();
const spanner = EventStore.ofSpanner(input);
```

After:

```ts
const store = EventStore.createDynamoDB(input);
const memory = EventStore.createMemory();
const spanner = EventStore.createSpanner(input);
```

互換用 alias は提供しません。

## Shard factory

Before:

```ts
const shardId = createShardId(value);
```

After:

```ts
const shardId = ShardId.create(value);
```

`createShardCount(...)` も同様に `ShardCount.create(...)` へ移行します。

## AggregateId の値

`AggregateIdValue` と `createAggregateIdValue(...)` は削除します。ライブラリは集約 ID の具象値型を所有しません。plain `string` をドメイン ID に保持し、検証は利用側の factory で行ってください。

Before:

```ts
type UserAccountId = AggregateId & {
  value: AggregateIdValue;
};
```

After:

```ts
type UserAccountId = AggregateId & {
  value: string;
};

namespace UserAccountId {
  export function create(value: string): UserAccountId {
    return Object.freeze({
      typeName: "user-account",
      value,
      asString: () => `user-account-${value}`,
    });
  }
}
```

ドメイン値が JSON 境界を越える場合は、同じ factory namespace に
`toJSON(...)` と `fromJSON(...)` を対で追加してください。module-private な
`unique symbol` brand はプロセス内で factory 生成値と plain object を
区別できますが、`JSON.stringify(...)` 後には消えます。

```ts
const USER_ACCOUNT_ID_BRAND: unique symbol = Symbol("UserAccountId");

type UserAccountId = AggregateId & {
  typeName: "user-account";
  readonly [USER_ACCOUNT_ID_BRAND]: true;
};

namespace UserAccountId {
  export function create(value: string): UserAccountId {
    return Object.freeze({
      [USER_ACCOUNT_ID_BRAND]: true,
      typeName: "user-account",
      value,
      asString: () => `user-account-${value}`,
    });
  }

  export function fromJSON(json: { typeName: "user-account"; value: string }) {
    return create(json.value);
  }
}
```

JSON 上の判別には `typeName`、または default serializer の `{ type, data }`
wrapper を使います。`EventSerializer.deserialize(bytes, converter)` と
`SnapshotSerializer.deserialize(bytes, converter)` のライブラリ API は変更せず、
converter の中でドメイン側の `fromJSON(...)` を呼んで brand を復元してください。
ライブラリ本体は JSON 専用の抽象ではなく、JSON 復元はサンプル converter の
実装 pattern です。

## interface

公開される構造的契約は `interface` 宣言ではなく type alias です。型 import の名前は維持しますが、TypeScript の宣言マージは互換契約の対象外です。

## Result error

回復可能な EventStore write 失敗は `Result` として返します。

Before:

```ts
try {
  await store.persistEvent(event, expectedVersion);
} catch (error) {
  if (error instanceof OptimisticLockError) {
    // retry or reload
  }
}
```

After:

```ts
const result = await store.persistEvent(event, expectedVersion);
if (
  result.type === "err" &&
  result.error.type === "optimistic-lock-conflict"
) {
  // retry or reload
}
```

## class ベースのサンプル

サンプルの集約 ID、イベント、集約は、不変オブジェクト値と同名 factory namespace で表現します。イベント replay は `instanceof` ではなく、`typeName` のような安定したイベントデータで分岐します。
