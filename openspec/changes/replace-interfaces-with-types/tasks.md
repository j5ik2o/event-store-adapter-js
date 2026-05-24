## 1. Public Type Contracts

- [ ] 1.1 Convert `Aggregate`, `AggregateId`, `Event`, `EventStore`, input contracts, serializers, `Logger`, and `ShardSelector` from `interface` declarations to object-shaped `type` aliases.
- [ ] 1.2 Preserve all existing exported type names from `src/index.ts` and `src/types.ts`.
- [ ] 1.3 Keep the same-name `EventStore` runtime factory object and rename construction methods to `EventStore.createDynamoDB(...)`, `EventStore.createMemory(...)`, and `EventStore.createSpanner(...)`.
- [ ] 1.4 Replace `createAggregateIdValue(...)`, `createShardId(...)`, and `createShardCount(...)` with `AggregateIdValue.create(...)`, `ShardId.create(...)`, and `ShardCount.create(...)`.
- [ ] 1.5 Remove old factory names without compatibility shims.
- [ ] 1.6 Add or update type-level tests that plain object values satisfy `Aggregate`, `AggregateId`, `Event`, and `EventStore` without class declarations.

## 2. Class-Free Runtime Implementation

- [ ] 2.1 Replace internal EventStore implementation classes with factory functions or closure-backed objects.
- [ ] 2.2 Replace internal helper classes such as aggregate keys, default serializers, shard selectors, private error classes, and test fakes with type aliases, object factories, or functions.
- [ ] 2.3 Keep `OptimisticLockError` as a public `Error` subclass and preserve `instanceof OptimisticLockError` behavior.
- [ ] 2.4 Route internal construction through `EventStore.createX(...)` or internal factory helpers so tests do not require direct implementation-class construction.
- [ ] 2.5 Keep public API objects frozen or otherwise non-mutable from supported caller usage.
- [ ] 2.6 Keep adapter-local mutable state isolated inside closures and defensively copy caller-provided mutable seed data.

## 3. Examples and Documentation

- [ ] 3.1 Rewrite example aggregate id, event, and aggregate models as type aliases plus same-name factory objects and immutable object values.
- [ ] 3.2 Replace example `instanceof` event dispatch with discriminated handling based on stable event data such as `typeName`.
- [ ] 3.3 Update README examples to show immutable object values and same-name factory objects instead of classes where the library only requires structural values.
- [ ] 3.4 Document the intentional breaking change that interface declaration merging is no longer part of the compatibility contract.
- [ ] 3.5 Document the intentional breaking change from old factory names to `create` methods.

## 4. Verification

- [ ] 4.1 Run formatter and lint for the library and examples.
- [ ] 4.2 Run the library build to verify generated declaration files preserve exported names.
- [ ] 4.3 Run the relevant Jest test suites, including EventStore contract tests.
- [ ] 4.4 Inspect generated `dist/*.d.ts` output for accidental runtime export removals or lost type exports.
- [ ] 4.5 Confirm old factory names are gone with `rg "createShardId|createShardCount|createAggregateIdValue|ofMemory|ofDynamoDB|ofSpanner" packages`.
- [ ] 4.6 Confirm library-authored classes are gone except `OptimisticLockError` and external SDK usage.
- [ ] 4.7 Run OpenSpec status for `replace-interfaces-with-types` and confirm the change remains apply-ready.
