## ADDED Requirements

### Requirement: Structural contracts use type aliases

The library SHALL author exported structural contracts as TypeScript `type` aliases instead of `interface` declarations.

#### Scenario: Type-only public contract import

- **WHEN** a caller imports `Aggregate`, `AggregateId`, `Event`, `EventStore`, serializer contracts, input contracts, `Logger`, or `ShardSelector` with `import type`
- **THEN** the imported name SHALL remain available as a type under the same exported name

#### Scenario: Plain object satisfies public contract

- **WHEN** a caller creates a plain object whose shape satisfies `Aggregate`, `AggregateId`, `Event`, or `EventStore`
- **THEN** TypeScript SHALL accept that value without requiring a class declaration or `implements` clause

#### Scenario: Declaration merging is not supported

- **WHEN** a caller attempts to augment a public structural contract through TypeScript interface declaration merging
- **THEN** the library SHALL NOT support that augmentation as part of its public compatibility contract

### Requirement: Runtime API values remain explicit

The library SHALL keep runtime values only where callers need a JavaScript value at runtime.

#### Scenario: EventStore create factories remain available

- **WHEN** a caller imports `EventStore` as a runtime value
- **THEN** `EventStore.createDynamoDB(...)`, `EventStore.createMemory(...)`, and `EventStore.createSpanner(...)` SHALL be available with the existing EventStore construction behavior

#### Scenario: Old EventStore factory names are removed

- **WHEN** a caller imports `EventStore` as a runtime value
- **THEN** `EventStore.ofDynamoDB(...)`, `EventStore.ofMemory(...)`, and `EventStore.ofSpanner(...)` SHALL NOT be part of the public API

#### Scenario: Optimistic lock error identity remains available

- **WHEN** a caller catches an optimistic locking failure
- **THEN** the thrown error SHALL remain compatible with `error instanceof OptimisticLockError`

### Requirement: Same-name value factories use create

The library SHALL expose value construction through same-name runtime factory objects with `create` methods.

#### Scenario: AggregateIdValue construction

- **WHEN** a caller constructs an aggregate id value
- **THEN** the caller SHALL use `AggregateIdValue.create(...)`

#### Scenario: ShardId construction

- **WHEN** a caller constructs a shard id
- **THEN** the caller SHALL use `ShardId.create(...)`

#### Scenario: ShardCount construction

- **WHEN** a caller constructs a shard count
- **THEN** the caller SHALL use `ShardCount.create(...)`

#### Scenario: Old free factory names are removed

- **WHEN** a caller imports library runtime values
- **THEN** `createAggregateIdValue(...)`, `createShardId(...)`, and `createShardCount(...)` SHALL NOT be part of the public API

### Requirement: Library-authored classes are limited to error identity

The library SHALL NOT use library-authored classes in production code, examples, or library test fixtures except for explicit public runtime error identity.

#### Scenario: Public optimistic lock error remains a class

- **WHEN** a caller imports `OptimisticLockError`
- **THEN** `OptimisticLockError` SHALL remain a runtime `Error` subclass that supports `instanceof`

#### Scenario: Internal implementation avoids classes

- **WHEN** production code, examples, or library test fixtures define library-authored runtime structures
- **THEN** those structures SHALL use type aliases, immutable object values, factory objects, or functions instead of `class`

#### Scenario: External SDK classes are out of scope

- **WHEN** code constructs values provided by external SDKs or tooling
- **THEN** this class restriction SHALL NOT apply to those external classes

### Requirement: Event dispatch is data discriminated

Example and test domain events SHALL use stable event data to select behavior rather than JavaScript constructor identity.

#### Scenario: Replay uses event typeName

- **WHEN** example or fixture replay code applies a stored domain event
- **THEN** it SHALL select behavior using discriminated event data such as `typeName`

#### Scenario: Replay does not depend on instanceof

- **WHEN** an event has been deserialized from storage into a structurally compatible event value
- **THEN** example or fixture replay code SHALL handle it without requiring `event instanceof SomeEventClass`

### Requirement: Store construction hides implementation shape

The library SHALL expose EventStore construction through factory methods rather than public implementation classes.

#### Scenario: Memory store construction

- **WHEN** a caller constructs an in-memory event store
- **THEN** the caller SHALL use `EventStore.createMemory(...)` and receive a value satisfying the `EventStore` type

#### Scenario: DynamoDB store construction

- **WHEN** a caller constructs a DynamoDB event store
- **THEN** the caller SHALL use `EventStore.createDynamoDB(...)` and receive a value satisfying the `EventStore` type

#### Scenario: Spanner store construction

- **WHEN** a caller constructs a Spanner event store
- **THEN** the caller SHALL use `EventStore.createSpanner(...)` and receive a value satisfying the `EventStore` type

### Requirement: Public values are immutable by default

The library SHALL model public domain-facing values and API objects as immutable values by default.

#### Scenario: Aggregate update returns new value

- **WHEN** an aggregate value updates its version or domain state
- **THEN** the update SHALL return a new aggregate value rather than mutating the existing value

#### Scenario: API object is not externally mutable

- **WHEN** the library returns a runtime API object such as `EventStore` or a value factory object
- **THEN** callers SHALL NOT be able to mutate the public API object's method table as part of supported usage

#### Scenario: Persistence internals may use localized mutation

- **WHEN** an adapter needs mutable state to implement the existing asynchronous persistence contract
- **THEN** that mutation SHALL remain localized inside the adapter and SHALL NOT expose caller-provided mutable objects directly
