# Migration Guide 3.0

このガイドは、DynamoDB と Cloud Spanner の shard 選択 API を揃えるために入った破壊的変更を説明します。

> 注: このガイドのコード例は v4.0 API に合わせて更新しています。
> v3.0 以前のコードを移行する場合は、`KeyResolver` を `ShardSelector` へ、
> `resolvePartitionKey` / `resolveSortKey` を `selectShardId` へ対応づけ、
> 更新後のコードでは `EventStore.createDynamoDB(...)`、
> `EventStore.createSpanner(...)`、`ShardId.create(...)` を使ってください。

## Shard 選択 API

`KeyResolver` と `SpannerShardSelector` は、ストレージ非依存の `ShardSelector` に置き換わりました。

変更前:

```ts
import type { KeyResolver } from "event-store-adapter-js";

const keyResolver: KeyResolver<UserAccountId> = {
  resolvePartitionKey: (aggregateId, shardCount) =>
    `${aggregateId.typeName}-${hash(aggregateId.asString()) % shardCount}`,
  resolveSortKey: (aggregateId, sequenceNumber) =>
    `${aggregateId.typeName}-${aggregateId.value}-${sequenceNumber}`,
};

const eventStore = EventStore.createDynamoDB({
  // ...
  keyResolver,
});
```

変更後:

```ts
import { ShardId, type ShardSelector } from "event-store-adapter-js";

const shardSelector: ShardSelector<UserAccountId> = {
  selectShardId: (aggregateId, shardCount) =>
    ShardId.create(hash(aggregateId.asString()) % shardCount),
};

const eventStore = EventStore.createDynamoDB({
  // ...
  shardSelector,
});
```

`EventStore.createSpanner(...)` でも同じ `ShardSelector` を使います。
EventStore input の `shardCount` は `number` のままですが、adapter が検証済みの `ShardCount` に parse してから selector に渡します。

```ts
const eventStore = EventStore.createSpanner({
  // ...
  shardSelector,
});
```

## DynamoDB key format

DynamoDB の `pkey` / `skey` 文字列生成は public extension point ではなくなりました。
DynamoDB の key format は internal に閉じ、利用者が差し替えられるのは shard 選択だけです。

組み込みの DynamoDB key format は従来どおりです。

```text
pkey = `${aggregateId.typeName}-${shardId}`
skey = `${aggregateId.typeName}-${aggregateId.value}-${sequenceNumber}`
```

以前 `resolveSortKey` をカスタマイズしていた場合は、アップグレード前に別途ストレージ移行として扱ってください。
