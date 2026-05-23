# Migration Guide 3.0

このガイドは、DynamoDB と Cloud Spanner の shard 選択 API を揃えるために入った破壊的変更を説明します。

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

const eventStore = EventStore.ofDynamoDB({
  // ...
  keyResolver,
});
```

変更後:

```ts
import { createShardId, type ShardSelector } from "event-store-adapter-js";

const shardSelector: ShardSelector<UserAccountId> = {
  selectShardId: (aggregateId, shardCount) =>
    createShardId(hash(aggregateId.asString()) % shardCount),
};

const eventStore = EventStore.ofDynamoDB({
  // ...
  shardSelector,
});
```

`EventStore.ofSpanner(...)` でも同じ `ShardSelector` を使います。
EventStore input の `shardCount` は `number` のままですが、adapter が検証済みの `ShardCount` に parse してから selector に渡します。

```ts
const eventStore = EventStore.ofSpanner({
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
