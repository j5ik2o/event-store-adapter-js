## Why

The library already exposes storage-neutral contracts as structural TypeScript types, but several public contracts are still authored with `interface` and examples rely on classes. This makes the intended contract look more nominal than it is, keeps `instanceof`-style domain modeling in the documented path, and leaves factory naming split between `createX(...)` functions and `EventStore.ofX(...)` methods.

## What Changes

- Replace exported public `interface` declarations with exported `type` aliases where the contract is structural.
- Replace library-authored classes in production code, examples, and library test fixtures with immutable object values, type aliases, and factory objects.
- Keep `OptimisticLockError` as the only library-authored class exception because callers may use `instanceof OptimisticLockError`.
- Keep external SDK classes out of scope.
- Update internal test fixtures and examples to demonstrate class-free aggregate, event, and aggregate id modeling with Scala-like immutable value style.
- Replace example event dispatch based on `instanceof` with discriminated data such as `typeName`.
- Rename public factory functions and methods to same-name factory objects with `create` methods.
- **BREAKING**: `EventStore.ofDynamoDB(...)`, `EventStore.ofMemory(...)`, and `EventStore.ofSpanner(...)` are replaced by `EventStore.createDynamoDB(...)`, `EventStore.createMemory(...)`, and `EventStore.createSpanner(...)`.
- **BREAKING**: `createAggregateIdValue(...)`, `createShardId(...)`, and `createShardCount(...)` are replaced by `AggregateIdValue.create(...)`, `ShardId.create(...)`, and `ShardCount.create(...)`.
- **BREAKING**: no compatibility shims are provided for the old factory names.
- **BREAKING**: declaration merging against exported interfaces will no longer be supported.

## Capabilities

### New Capabilities

- `type-based-contracts`: Structural public contracts are authored as `type` aliases, library-authored classes are removed except explicit runtime error identity, and factories use same-name `create` objects.

### Modified Capabilities

- None.

## Impact

- Public API: `Aggregate`, `AggregateId`, `Event`, `EventStore`, input contracts, serializers, logger, and shard selector remain exported under the same type names but become type aliases where applicable.
- Runtime API: `EventStore.createDynamoDB(...)`, `EventStore.createMemory(...)`, `EventStore.createSpanner(...)`, `AggregateIdValue.create(...)`, `ShardId.create(...)`, `ShardCount.create(...)`, and `OptimisticLockError`.
- Examples and tests: domain fixtures move away from class-based `implements` and `instanceof` patterns and toward immutable factory-created values.
- Documentation: README examples should show immutable object values and same-name factory objects rather than classes where the library does not require classes.
