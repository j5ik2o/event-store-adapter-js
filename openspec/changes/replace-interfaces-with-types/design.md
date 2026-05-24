## Context

The current package is a pre-release TypeScript library whose domain-facing API is already structurally typed: callers import `Aggregate`, `AggregateId`, `Event`, `EventStore`, serializers, input contracts, and extension points as types. Several of those contracts are authored with `interface`, and the examples model aggregates, ids, and events with classes plus `instanceof` dispatch.

This creates two problems:

- Type-only contracts look nominal even though the library accepts any structurally compatible value.
- Example code teaches runtime class identity for events, even though serialized events cross storage boundaries and are better discriminated by stable data such as `typeName`.
- Factory naming is split between free `createX(...)` functions and `EventStore.ofX(...)` methods, even though the desired model is same-name factory objects such as `UserAccountId.create(...)`.

The package still has runtime values that must remain runtime values. `EventStore` is both a type name and a frozen constructor object, and `OptimisticLockError` is a public error class used with `instanceof`.

## Goals / Non-Goals

**Goals:**

- Author structural public contracts as `type` aliases instead of `interface`.
- Preserve exported names so `import type { EventStore }` and similar type imports keep working.
- Preserve the `EventStore` runtime factory object while renaming construction methods to `createDynamoDB`, `createMemory`, and `createSpanner`.
- Replace `createAggregateIdValue(...)`, `createShardId(...)`, and `createShardCount(...)` with same-name factory objects: `AggregateIdValue.create(...)`, `ShardId.create(...)`, and `ShardCount.create(...)`.
- Keep public error identity for `OptimisticLockError`.
- Remove library-authored classes from production code, examples, and library test fixtures except `OptimisticLockError`.
- Move examples and internal fixtures away from class-based domain objects and `instanceof` event dispatch.
- Prefer object factories and immutable object copies when replacing classes, following a Scala-like immutable value style.
- Keep the existing EventStore behavior, storage schemas, and persistence semantics unchanged.

**Non-Goals:**

- Do not introduce a functional programming framework or new runtime dependency.
- Do not provide compatibility shims for old factory names.
- Do not change DynamoDB, memory, or Spanner storage behavior.
- Do not remove `OptimisticLockError` as a class unless a separate compatibility-breaking error contract is proposed.
- Do not attempt to remove external SDK classes such as AWS SDK, Google Cloud Spanner, or testcontainers classes.
- Do not add compatibility shims for declaration merging.

## Decisions

### Convert public interfaces to object-shaped type aliases

Public contracts such as `Aggregate`, `AggregateId`, `Event`, input contracts, serializer contracts, `Logger`, `ShardSelector`, and the `EventStore` type are converted from `interface` declarations to `type` aliases with object shapes.

This keeps structural typing explicit and preserves type import names. The known breaking point is declaration merging. That is acceptable for this unreleased cleanup because these contracts are intended to be closed library contracts, not user-augmented ambient extension points.

Alternative: keep interfaces and only change examples. That would reduce surface churn, but the source would continue to communicate an extensible interface model that the library does not need.

### Keep same-name type and runtime value for EventStore, but rename factories to createX

`EventStore` remains both:

- a type alias for the persistence contract
- a runtime frozen object with `createDynamoDB`, `createMemory`, and `createSpanner`

The runtime object remains the single public construction boundary, but factory method names move to `create` for consistency with value factories such as `UserAccountId.create(...)`, `ShardId.create(...)`, and `AggregateIdValue.create(...)`. The implementation should keep type-only imports explicit where a file uses both the type and runtime value.

Alternative: keep `EventStore.ofX(...)` as the only exception. That preserves fewer call-site changes, but it weakens the "one factory vocabulary" rule and keeps an unnecessary naming split.

### Replace public value factories with same-name create objects

Public value factories become same-name runtime objects:

- `AggregateIdValue.create(value)`
- `ShardId.create(value)`
- `ShardCount.create(value)`

The previous free functions are removed without shims. This is a breaking change, but it avoids a double API and makes new domain examples line up with the public API style.

Alternative: retain `createAggregateIdValue(...)`, `createShardId(...)`, and `createShardCount(...)` as deprecated aliases. That would ease migration but keep two equally available construction paths in a pre-release cleanup.

### Remove library-authored classes except explicit runtime identity

Library-authored classes are not allowed in production code, examples, or library test fixtures, except public runtime error identity such as `OptimisticLockError`. External SDK classes are out of scope.

Internal store implementations move from classes to factory functions returning frozen or immutable method objects. This applies to internal `MemoryEventStore`, `DynamoDBEventStore`, `SpannerEventStore`, aggregate key helpers, default serializers, shard selectors, and test fakes.

The public `EventStore.createX(...)` methods remain the construction boundary, so callers should not observe whether the returned object came from a class or a closure.

Alternative: convert only public type declarations and leave internal classes. That is a smaller diff, but it would only partially address the "stop using classes" goal and would leave test fixtures teaching the old style.

### Keep OptimisticLockError as a public runtime class

`OptimisticLockError` remains a class extending `Error`. Existing callers can reasonably branch with `error instanceof OptimisticLockError`, and replacing that with a type alias or tagged object would be a runtime breaking change beyond this cleanup.

Internal custom error classes should be replaced with ordinary `Error` creation helpers when their identity is not observed.

Alternative: replace all error classes with tagged errors. That would remove more classes, but it would also break the most valuable runtime identity currently exported by the package.

### Use immutable values and localized mutation

Public domain values and API objects are immutable. Domain examples use type aliases plus same-name factory objects, and update operations return new values rather than mutating existing values. Aggregate methods such as `withVersion(...)` and `updateVersion(...)` remain because they are part of the existing aggregate contract, but their implementations do not depend on mutable `this` state.

Persistence adapter internals may use localized mutation only when the mutation is not externally observable and is required to implement the existing async persistence contract. For example, the in-memory store may mutate closure-owned `Map` instances, but it must defensively copy seed input and return immutable API objects.

Alternative: make every persistence operation return a new store value. That would be purer, but it would change the existing `EventStore` side-effecting persistence contract.

### Keep aggregate behavior on immutable objects

Aggregate values remain method-bearing immutable objects because the `Aggregate` contract currently includes `withVersion(...)` and `updateVersion(...)`. Event values remain data-only, and aggregate id values keep the existing `asString()` method. Methods should be closures or helpers that return new object values and avoid rebinding-sensitive `this` behavior.

Alternative: move all behavior into free functions. That would be closer to pure data plus functions, but it would broaden the public contract change beyond this cleanup.

### Use discriminated event data instead of instanceof in examples

Example events become object-shaped values with stable literal `typeName` values. Replay and apply logic switches on `event.typeName` rather than `event instanceof SomeClass`.

This better matches serialization boundaries: after persistence round trips, event identity should be data-driven, not constructor-driven.

Alternative: keep event classes and use static factory functions. That still teaches class identity as the primary domain pattern.

## Risks / Trade-offs

- [Users relying on declaration merging lose that extension point] -> Treat this as an intentional pre-release breaking change and document it in the proposal and release notes.
- [Users relying on old factory names must update call sites] -> Do not provide shims; update README, examples, tests, and search for old names before completion.
- [Same-name `EventStore` type/value can become confusing during edits] -> Use `import type` consistently and keep the constructor object type private.
- [Class-to-object rewrites can accidentally change method `this` behavior] -> Prefer closure-based functions and object factory helpers over methods that depend on rebinding.
- [Event dispatch changes can miss exhaustive checks] -> Use discriminated unions with literal `typeName` and `never` exhaustiveness checks.
- [Internal tests may currently instantiate implementation classes directly] -> Route tests through internal factory helpers or `EventStore.createX(...)` where possible, keeping storage contract tests unchanged.
- [Localized mutation can leak from in-memory store seed data] -> Continue defensive copying at the input boundary and keep mutable state inside closures only.
