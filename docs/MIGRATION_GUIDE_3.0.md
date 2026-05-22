# Migration Guide 3.0

This guide covers breaking API changes introduced while aligning DynamoDB and Cloud Spanner shard selection.

## Shard selection API

`KeyResolver` and `SpannerShardSelector` were replaced by the storage-neutral `ShardSelector`.

Before:

```ts
import type { KeyResolver } from "event-store-adapter-js";

const keyResolver: KeyResolver<UserAccountId> = {
  resolvePartitionKey: (aggregateId, shardCount) =>
    `${aggregateId.typeName}-${hash(aggregateId.asString()) % shardCount}`,
  resolveSortKey: (aggregateId, sequenceNumber) =>
    `${aggregateId.typeName}-${aggregateId.value}-${sequenceNumber}`,
};

const eventStore = EventStoreFactory.ofDynamoDB({
  // ...
  keyResolver,
});
```

After:

```ts
import { createShardId, type ShardSelector } from "event-store-adapter-js";

const shardSelector: ShardSelector<UserAccountId> = {
  selectShardId: (aggregateId, shardCount) =>
    createShardId(hash(aggregateId.asString()) % shardCount),
};

const eventStore = EventStoreFactory.ofDynamoDB({
  // ...
  shardSelector,
});
```

The same `ShardSelector` type is used by `EventStoreFactory.ofSpanner(...)`.

```ts
const eventStore = EventStoreFactory.ofSpanner({
  // ...
  shardSelector,
});
```

## DynamoDB key formatting

Custom DynamoDB `pkey` / `skey` formatting is no longer part of the public extension point.
DynamoDB key formatting is internal, while custom behavior is limited to shard selection.

The built-in DynamoDB key format remains:

```text
pkey = `${aggregateId.typeName}-${shardId}`
skey = `${aggregateId.typeName}-${aggregateId.value}-${sequenceNumber}`
```

If you previously customized `resolveSortKey`, move that data model change to a separate storage migration before upgrading.
