# Migration Guide 4.0

Version 4.0 is an intentional breaking release. The package keeps structural type names such as `Aggregate`, `AggregateId`, `Event`, and `EventStore`, but runtime factories now use same-name factory objects.

## EventStore factories

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

Compatibility aliases are not provided.

## Shard factories

Before:

```ts
const shardId = createShardId(value);
```

After:

```ts
const shardId = ShardId.create(value);
```

`createShardCount(...)` similarly becomes `ShardCount.create(...)`.

## AggregateId values

`AggregateIdValue` and `createAggregateIdValue(...)` are removed. The library no longer owns a concrete aggregate id value type. Keep a plain `string` in your domain id and validate it in your own factory.

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

## Interfaces

Exported structural contracts are type aliases, not `interface` declarations. Type-only imports continue to use the same names, but TypeScript declaration merging is no longer a supported compatibility contract.

## Result errors

Recoverable EventStore write failures are returned as `Result` values.

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

## Class-based samples

The examples now model aggregate ids, events, and aggregates as immutable object values with same-name factory namespaces. Event replay branches on stable event data such as `typeName`, not `instanceof`.
