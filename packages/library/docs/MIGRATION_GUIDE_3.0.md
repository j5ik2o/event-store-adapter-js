# Migration Guide 3.0

This guide covers breaking API changes introduced while aligning DynamoDB and Cloud Spanner shard selection.

> Note: The examples in this guide are kept current with the v4.0 API surface.
> When migrating legacy v3.0 code, map `KeyResolver` to `ShardSelector`,
> `resolvePartitionKey` / `resolveSortKey` to `selectShardId`, and use
> `EventStore.createDynamoDB(...)`, `EventStore.createSpanner(...)`, and
> `ShardId.create(...)` in the updated code.

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

const eventStore = EventStore.createDynamoDB({
  // ...
  keyResolver,
});
```

After:

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

The same `ShardSelector` type is used by `EventStore.createSpanner(...)`.
`shardCount` remains a `number` in EventStore input objects, but the adapter parses it into a validated `ShardCount` before calling your selector.

```ts
const eventStore = EventStore.createSpanner({
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
