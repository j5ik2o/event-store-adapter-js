> This document is the design record written while building v5. Check the [README](../../README.md) and the current code for current usage.

# Design of the Next Major Version (5.0.0)

This document is the design proposal for the next major version of event-store-adapter-js. It contains no code. The coordinator reviews it, the points decided by the owner (Chapter 9) are reflected, and then it is used for implementation.

- Normative sources: the hub (j5ik2o/event-store-adapter) `docs/spec/core-contract.md`, `docs/spec/storage/dynamodb.md`, `docs/spec/storage/memory.md`, `docs/plan/implementation-plan.md`, and `docs/adr/`.
- Conformance test data: `conformance/` in this repository (v1.0.0; `conformance/README.md` explains how to read it).
- Rule numbers (T-1, W-8, DY-9, etc.) are the numbers in the normative sources above. This document adds no rules and changes no specifications.
- "Current" means 4.0.x at the time this design was written (the version in `packages/library/package.json` is `4.0.2-snapshot.0`). The implementation based on this design has entered main, and the version became `5.0.0-snapshot.0`.
- Chapter 9 keeps the points decided by the owner and the reasons. The only pending item is the Spanner entry point.
- Passages marked "design decision" are designs decided by this document, not rules of the specification.

## 1. Purpose and Scope

### 1.1 Purpose

Rewrite the library to conform to the common contract (envelope model, ADR-0001). The current public API performs optimistic locking with the aggregate's `version`, decides the event kind with `isCreated`, and leaves `asString()` to the user's implementation. The new version replaces these with the envelope, the head, and `seqNr`.

### 1.2 Version Number of the Next Major

**5.0.0**. The current version is 4.0.x, and 4.0.0 has only just been released. The next one will be the second major (premise of the instructions). While the migration is in progress, the main Snapshot is published in the form `5.0.0-snapshot.<run>.<attempt>` (Chapter 7).

### 1.3 Contents of the First Major (IP-D3, IP-D4)

| Target | Content | Main rules |
|:--|:--|:--|
| Core | Aggregate ID, envelope, integer and time types, serializer, four operations, error classification, configuration validation | T-1 to T-13, W-3 to W-9, R-1 to R-6, E-1 to E-3, S-1 |
| Memory | Single-process in-memory store. Conformance is also declared (IP-D4) | MEM-1 to MEM-13 |
| DynamoDB | Rebuilt with three tables and configuration items | D-3 to D-9, DY-2, DY-3, DY-8 to DY-12, DY-16 to DY-19 |
| Conformance test data runner | Passes all cases on both Memory and DynamoDB | Chapter 5 |

### 1.4 Excluded Items

| Target | Handling |
|:--|:--|
| Spanner | Not shipped in the first major. It will be shipped again in stage 5 (IP-D3, IP 4.2). This is not a permanent removal. The current `EventStore.createSpanner`, `SpannerEventStoreInput`, the `@google-cloud/spanner` peer dependency, and the Spanner tests and examples are removed at the removal point (Chapter 7). How to split the entry point so that Spanner is an optional dependency is item 2 of Chapter 9 (pending; to be decided by stage 5) |
| Change feed | The first major includes neither a function that assembles head transitions nor any helper for resynchronization (DY-15) (owner's decision, 2026-10-06). Enabling Streams on the head table is the responsibility of the table creation side (outside the library) |
| TTL mode (Memory) | MEM-12. Requesting it is a configuration error |
| Change feed (Memory) | MEM-13. Requesting it is a configuration error |
| Logical shards | ADR-0006, DY-16. `ShardSelector`, `shardCount`, and `ShardId` are removed |
| Loading old data | Loading the old layout is not provided. Only a procedure document is prepared (Chapter 8, IP-D8) |
| Creating the three tables | Outside the library (dynamodb.md 3.1) |

### 1.5 Non-goals

- Changing or adding specifications or rules.
- Designs for other languages (rs, java, go).
- A backward-compatibility layer. Coexistence of the old API and the new API is an internal matter of the migration period in Chapter 7 and is not made public.

## 2. Public API

### 2.1 Premises

- The language is TypeScript (`strict`), the build is CommonJS with target es6 (following the current `tsconfig`), and the runtime is Node.js 24 or later (the current `engines`).
- Values are immutable (`Readonly`, `Object.freeze`). Inputs are not modified.
- Follow the current style (place functions in a `namespace` with the same name as the `type`, `Object.freeze` it, and re-export from `index.ts`).
- One public type goes in one file (project rule).
- File locations (design decision): the file names below (such as `aggregate-id.ts`) are the names at the final location, `packages/library/src/`. Because files with the same names exist in the current `src/`, the new implementation is placed under `packages/library/src/next/` with the same names until the old implementation is removed (PR 13 in Chapter 7). In PR 13, the old implementation is deleted and the contents of `src/next/` are moved to `src/` (7.2).
- Failures are returned as `Result<T, EventStoreError>` (the current `result.ts`) for all write, read, and creation operations (owner's decision, item 1 of Chapter 9).
- The name follows `seq_nr` of the common contract and is `seqNr`. `sequenceNumber` is removed.

### 2.2 Aggregate ID (T-1, T-11, T-12)

```ts
// aggregate-id.ts
export type AggregateId = Readonly<{
  typeName: string; // T-11: "-" を含まない
  value: string;
}>;

export namespace AggregateId {
  /** T-11・T-12 を検査して作る。違反は ContractViolation（rule = "T-11" | "T-12"）。 */
  export function of(
    typeName: string,
    value: string,
  ): Result<AggregateId, EventStoreError>;

  /** T-1: `${typeName}-${value}` をライブラリが組み立てる。利用者の asString() には依存しない。T-11・T-12 を検査し、違反は ContractViolation。 */
  export function asString(id: AggregateId): Result<string, EventStoreError>;
}
```

- `asString` checks that the type name does not contain `-` (T-11) and that the total UTF-8 byte count of the type name, the value, and the separator is at most 1024 (T-12), and returns violations as a `Result` failure. It counts with `Buffer.byteLength(s, "utf8")`, not by character count. This detects the multi-byte cases in the conformance data.
- Because users can pass their own objects, each store operation also re-validates through `AggregateId.asString` and returns a failure as the failure of the operation as it is. T-11 and T-12 are enforced even for values that did not go through `AggregateId.of` (the same applies to MEM-5).
- An empty type name and an empty value are allowed. The specification (T-11, T-12) does not forbid them, and the aid string contains `-`, so it is never empty (lead's answer, 2026-10-06). The conformance data has no such case, so the unit tests in PR 3 check an empty type name (`-value`), an empty value (`typeName-`), and both empty (`-`).
- The current `AggregateId`'s `asString: () => string` is removed. It holds only the type name and the value.

### 2.3 Integer and Time Types (T-9, T-13, 1.5)

| Value | Type | Validation |
|:--|:--|:--|
| `seqNr` | `number` | T-9: an integer from 0 to `Number.MAX_SAFE_INTEGER` (2^53−1). Out of range is a contract violation. For events, 0 is also a contract violation (W-6) |
| `occurredAt` | `Date` (T-3 states that js `Date` has millisecond precision) | T-13: nanoseconds since the epoch fit in a signed 64-bit range. Out of range is a contract violation |

- A JS `number` can represent negative values, so the `signed_seq_nr` cases are executed. 2^53 is exactly representable as a `number`. Values beyond it cannot be represented as a `number`, so the runner reads them as BigInt, and values that do not convert back exactly through `Number` are reported as "not representable" (5.1).
- `Date` has millisecond precision. T-3 allows rounding to the precision of the standard time type, so values are rounded to milliseconds. Cases with `representation.time_precision = milliseconds` are executed, and cases with `nanoseconds` are not applicable (reported with the reason, 5.1).
- The T-13 range (about the year 1677 to 2262) is narrower than the `Date` range. The check converts milliseconds to nanoseconds using BigInt. An invalid `Date` (`NaN`) is also a contract violation (T-13).

### 2.4 Event Envelope (T-2, T-3, T-4, T-5, T-13)

```ts
// event-envelope.ts
export type EventEnvelope<P = unknown> = Readonly<{
  aggregateId: AggregateId; // T-2 必須
  seqNr: number;            // T-2・T-9・W-6
  occurredAt: Date;         // T-2・T-3・T-13
  manifest: string;         // T-2: 省略時は ""。T-4: 解釈しない
  payload: P;               // T-2 必須。T-6・T-7
}>;

export type EventEnvelopeInput<P = unknown> = Readonly<{
  aggregateId: AggregateId;
  seqNr: number;
  occurredAt: Date;
  manifest?: string;
  payload: P;
}>;

export namespace EventEnvelope {
  /** T-2: 必須要素の欠落を検査し、違反は ContractViolation（rule "T-2"）。manifest を "" で埋める。T-9・T-13・W-6 を検査し、違反は ContractViolation。 */
  export function create<P>(
    input: EventEnvelopeInput<P>,
  ): Result<EventEnvelope<P>, EventStoreError>;
}
```

- T-5: The envelope is immutable (`Object.freeze`). Even if elements are added, existing user code does not break because the construction function takes an input object.
- Missing required elements (common contract T-2, T-10, P-42): in TypeScript the types express what is required, but untyped JavaScript may call without them. Therefore `EventEnvelope.create` and `SnapshotEnvelope.create` check at runtime and return a contract violation (`rule: "T-2"`; `"T-10"` for snapshots) as a `Result` failure. An element is considered missing when `aggregateId`, `seqNr`, or `occurredAt` (only `seqNr` for snapshots) is `undefined` or `null`, or when `payload` (`aggregate` for snapshots) is `undefined`. A JSON `null` in `payload` is allowed as a value. If the missing element is `seqNr`, the message does not include seqNr (E-3). In implementation PR 3, unit tests for the missing case are written for each element.
- T-3: The store does not replace `occurredAt` with the store's time. Reads return the same value (millisecond precision).
- `Date` is mutable. Therefore Memory keeps `occurredAt` as a millisecond number (`getTime()`) and creates a new `Date` each time it is returned on read (MEM-6). It does not keep a reference to the input `Date`.
- The current `Event`'s `typeName`, `id`, and `isCreated` are removed. Domain events go into `payload`.
- Envelopes that did not go through `create` are also accepted, so the write entry points (`persistEvent`, `persistEventAndSnapshot`) run the same checks again (T-2 and T-10 for missing required elements, W-6, T-9, T-13). A missing `payload` or `aggregate` is returned as a contract violation before it becomes a serialization failure, and a missing `aggregateId` before it becomes an exception. The tests in PR 5 check the case of passing an envelope with missing elements directly without going through `create`.

### 2.5 Snapshot Envelope (T-10)

```ts
// snapshot-envelope.ts
export type SnapshotEnvelope<S = unknown> = Readonly<{
  aggregate: S;       // T-10 必須。T-6・T-7
  seqNr: number;      // T-10・T-9
  manifest: string;   // T-10: 省略時は ""
}>;

export type SnapshotEnvelopeInput<S = unknown> = Readonly<{
  aggregate: S;
  seqNr: number;
  manifest?: string;
}>;

export namespace SnapshotEnvelope {
  /** T-10: 必須要素の欠落を検査し、違反は ContractViolation（rule "T-10"）。manifest を "" で埋める。T-9 を検査する。 */
  export function create<S>(
    input: SnapshotEnvelopeInput<S>,
  ): Result<SnapshotEnvelope<S>, EventStoreError>;
}

// latest-snapshot.ts（R-2・R-3、ADR-0002）
export type LatestSnapshot<S = unknown> = Readonly<{
  snapshot?: SnapshotEnvelope<S>; // なくてもよい（R-3）
  headSeqNr: number;              // 読み取り時点のヘッドの seqNr
}>;
```

- The head's `seqNr` is not included in the envelope and is returned separately as `LatestSnapshot.headSeqNr` (ADR-0002). Writes and reads use the same `SnapshotEnvelope` type.
- The current `Aggregate` (`version`, `withVersion`, `updateVersion`) is removed. The aggregate is a domain-side type and goes into the `aggregate` field.

### 2.6 Payload and Serializer (T-6, T-7, T-8)

```ts
// payload-serializer.ts
export type PayloadSerializer<P> = {
  serialize(payload: P): Uint8Array;
  deserialize(bytes: Uint8Array, manifest: string): P;
};

export namespace PayloadSerializer {
  /** T-8: 既定は JSON。UTF-8 の JSON 文字列を Uint8Array にする。 */
  export function json<P = unknown>(): PayloadSerializer<P>;
}
```

- T-6: Domain types are not required to use library types. `P` can be any type as long as the serializer can serialize it.
- T-7: The serializer handles only the payload. It does not embed metadata (aggregateId, seqNr, occurredAt). The current `EventSerializer` and `SnapshotSerializer` (which handle the whole event or whole aggregate and take a `converter` argument) are removed.
- `manifest` is passed to `deserialize` so that one serializer can restore payloads of multiple types. The library does not interpret the manifest (T-4); it only passes it along. T-4 does not forbid passing it, so this form was decided (lead's review, 2026-10-06).
- Exceptions thrown by a serializer are caught by the library and classified as `serialization` (`operation` is `serialize` or `deserialize`).
- The default JSON uses `JSON.stringify` / `JSON.parse`. `undefined`, functions, and `BigInt` cannot be serialized and result in a serialization failure.

### 2.7 Operations (Chapter 3) and Asynchronous Representation

```ts
// event-store.ts
export type EventStore<PE = unknown, PS = unknown> = {
  /** 3.1・H-3・W-3〜W-8 */
  persistEvent(
    event: EventEnvelope<PE>,
  ): Promise<Result<void, EventStoreError>>;

  /** 3.2・W-9: snapshot.seqNr !== event.seqNr は契約違反 */
  persistEventAndSnapshot(
    event: EventEnvelope<PE>,
    snapshot: SnapshotEnvelope<PS>,
  ): Promise<Result<void, EventStoreError>>;

  /** 3.4・R-1〜R-3・R-8。ヘッドがなければ undefined（エラーにしない） */
  getLatestSnapshotById(
    aggregateId: AggregateId,
  ): Promise<Result<LatestSnapshot<PS> | undefined, EventStoreError>>;

  /** 3.5・R-4〜R-6。seqNr 以上を昇順で全件返す */
  getEventsByIdSinceSeqNr(
    aggregateId: AggregateId,
    seqNr: number,
  ): Promise<Result<EventEnvelope<PE>[], EventStoreError>>;
};
```

- Asynchrony is expressed with `Promise` (same as the current one). The Memory implementation also returns a `Promise`. This is so that callers can swap the storage.
- Writes take no expected-value argument. The expected value for the check is determined from `event.seqNr` (W-3, W-4, W-8). `expectedVersion` is removed.
- The name changes from the current `getEventsByIdSinceSequenceNumber` to `getEventsByIdSinceSeqNr`.
- The `seqNr` argument of reads is also checked by T-9. 0 is valid under T-9 (all events with seqNr 0 or greater are returned).
- Common rules for writes (3.3):

| Condition | Result | Rule |
|:--|:--|:--|
| `seqNr = 0` | Contract violation | W-6 |
| `seqNr = 1`, no head | New creation | W-3 |
| `seqNr = 1`, head exists | Optimistic lock | W-3 |
| `seqNr ≥ 2`, `seqNr = head + 1` | Update | W-4, W-8 |
| `seqNr ≥ 2`, `seqNr ≤ head` | Optimistic lock | W-7, W-8 |
| `seqNr ≥ 2`, `seqNr ≥ head + 2` (head 0 when there is no head) | Contract violation (gap) | W-8 |
| `snapshot.seqNr ≠ event.seqNr` | Contract violation | W-9 |

- R-8 is stated explicitly per storage (Memory is atomic, DynamoDB is non-atomic). It is written in Chapters 3 and 4.

#### Creation Functions

```ts
export namespace EventStore {
  export function createMemory<PE, PS>(
    input?: MemoryEventStoreInput<PE, PS>,
  ): Result<EventStore<PE, PS>, EventStoreError>;

  export function createDynamoDB<PE, PS>(
    input: DynamoDBEventStoreInput<PE, PS>,
  ): Promise<Result<EventStore<PE, PS>, EventStoreError>>;
}
```

- Creation failures are also classified and returned (instructions, 4.2). Memory validates the configuration synchronously (MEM-3). DynamoDB returns a `Promise` because reading and creating the configuration items involve I/O (DY-8, P-40). DynamoDB runs a configuration-item `BatchGetItem` on every creation (4.2). Faults at creation time (`operation = 0` in `faults`) are registered by the runner before creation, and are consumed by SDK requests during creation and by the serializer wrapper (5.4).
- The current `createDynamoDB` and `createMemory` return the store synchronously, and configuration errors were exceptions. They are replaced.

### 2.8 Error Classification (Chapter 4)

```ts
// event-store-error.ts
export type EventStoreError =
  | { type: "optimistic-lock-conflict"; message: string; aggregateId: string; seqNr: number; headSeqNr?: number; cause?: unknown }
  | { type: "contract-violation"; rule: ContractRule; message: string; seqNr?: number; snapshotSeqNr?: number; cause?: unknown }
  | { type: "serialization-error"; operation: "serialize" | "deserialize"; message: string; cause?: unknown }
  | { type: "configuration-error"; fieldName: string; message: string; cause?: unknown }
  | { type: "storage-error"; message: string; cause?: unknown };

export type ContractRule = "T-2" | "T-9" | "T-10" | "T-11" | "T-12" | "T-13" | "W-6" | "W-8" | "W-9" | "D-7";
```

| Classification | `type` | Main occurrences |
|:--|:--|:--|
| Optimistic lock | `optimistic-lock-conflict` | seq_nr=1 on an existing aggregate (W-3), duplicate seq_nr (W-7), append at or below the head (W-8), TransactionConflict (D-6) |
| Contract violation | `contract-violation` | W-6, W-9, T-9, T-11, T-12, T-13, gap in W-8, D-7 |
| Serialization | `serialization-error` | Failure to serialize or restore the payload |
| Configuration | `configuration-error` | Invalid value at creation (such as retention count 0), mismatch with the configuration recorded in the storage (P-40) |
| Storage | `storage-error` | Communication or storage failures, missing data in what was read, reaching the limit on reading the configuration (DY-8) |

- E-1: Callers distinguish classifications by discriminating on `error.type` (a discriminated union). They do not infer the classification from the message string. The `type` values of the current four classifications (`optimistic-lock-conflict`, `configuration-error`, `serialization-error`, `storage-error`) are kept, and `contract-violation` is added.
- E-2: The optimistic-lock message may include only the aid string, the seqNr being appended, and (if known) the head's seqNr. It does not include connection strings, credentials, or raw SDK error text. The SDK exception goes into `cause`, not into `message`.
- E-3: The contract-violation message includes the number of the violated rule. The related seqNr is included only when there is one (it is not included when there is no related seqNr, as with a T-11 type-name violation). For W-9, both `seqNr` and the differing snapshot number `snapshotSeqNr` are included. The head number is not a required value of a contract violation. A D-7 size excess only needs to satisfy the classification `contract-violation` (no rule number or message condition).
- Construction functions are placed in the `namespace` of `EventStoreError` (same form as the current one):

```ts
export namespace EventStoreError {
  export function optimisticLockConflict(input: { aggregateId: string; seqNr: number; headSeqNr?: number; cause?: unknown }): EventStoreError;
  export function contractViolation(input: { rule: ContractRule; seqNr?: number; snapshotSeqNr?: number; detail?: string; cause?: unknown }): EventStoreError;
  export function serialization(operation: "serialize" | "deserialize", message: string, cause?: unknown): EventStoreError;
  export function configuration(fieldName: string, message: string, cause?: unknown): EventStoreError;
  export function storage(message: string, cause?: unknown): EventStoreError;
}
```

- `contractViolation` builds the `message`. Except for D-7, it always includes `rule`, and includes `seqNr` and `snapshotSeqNr` only when they are passed. For W-9 the caller passes both. `optimisticLockConflict` builds the `message`. It has no argument that receives an SDK message. This enforces E-2 by structure.
- The current `optimisticLockConflict(message?, cause?)` lets callers pass any message. It is replaced.

### 2.9 Configuration (S-1, MEM-3) and Retention Failure Notification (S-4, MEM-11)

```ts
// snapshot-retention.ts
export type SnapshotRetention = Readonly<{
  count: number; // S-1: 1 以上の整数。0・負数・小数・NaN は設定エラー
  mode?: { type: "delete" } | { type: "ttl"; graceSeconds: number }; // 既定は delete
}>;

// retention-failure.ts（S-4・MEM-11）
export type RetentionFailure = Readonly<{
  kind: "retention-failure";
  aggregateId: string;
  cause: unknown;
}>;

// memory-event-store-input.ts
export type MemoryStorage = { /* 内部の記録・設定・排他制御（不透明） */ };
export type MemoryStorageInput = Readonly<{
  retention?: SnapshotRetention;           // MEM-3: 設定は保存先が持つ。mode は delete のみ（ttl は設定エラー）
  changeFeed?: unknown;                    // 未提供の能力の要求。指定されたら設定エラー（MEM-3・MEM-13）
}>;
export namespace MemoryStorage {
  /** MEM-3: 設定を検査し、不変な設定を持つ空の独立した保存先を作る。 */
  export function create(input?: MemoryStorageInput): Result<MemoryStorage, EventStoreError>;
}

export type MemoryEventStoreInput<PE, PS> = Readonly<{
  storage?: MemoryStorage;                 // MEM-2: 同じ storage を渡したときだけ共有。省略時は新しい独立した保存先
  eventSerializer?: PayloadSerializer<PE>; // 既定は JSON
  snapshotSerializer?: PayloadSerializer<PS>;
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
}>;

// dynamodb-event-store-input.ts
export type DynamoDBEventStoreInput<PE, PS> = Readonly<{
  client: DynamoDBClient;
  tables: Readonly<{ journal: string; snapshot: string; head: string }>; // DY-8
  snapshotAidIndexName: string;            // D-3: (aid, active_history_seq_nr) の疎な GSI
  eventSerializer?: PayloadSerializer<PE>;
  snapshotSerializer?: PayloadSerializer<PS>;
  retention?: SnapshotRetention;           // なし = 履歴なし（S-1）
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
  retryLimit?: number;                     // DY-8: 設定照合の再要求回数の上限（初回は数えない）。既定 5（設計判断、4.2）
}>;
```

- Values that cause a configuration error: `retention.count` is not an integer of 1 or more (S-1). `graceSeconds` is not a safe integer of 0 or more (`Number.isSafeInteger`). No upper limit is defined (lead's answer, 2026-10-06), but a value that a `number` cannot represent exactly (2^53 or more) is treated as an invalid configuration value at creation and results in a configuration error. In Memory, `mode.type = "ttl"` (MEM-3, MEM-12). For a configuration requesting a change feed in Memory (MEM-3, MEM-13), `MemoryStorageInput` has `changeFeed?: unknown`, and if a value is specified (anything other than `undefined`), `MemoryStorage.create` returns a `configuration-error` (`fieldName = "changeFeed"`). This is because merely not having the field in the type cannot reject input from JavaScript at runtime. The retention configuration is held by the Memory storage, so instances sharing the same `MemoryStorage` use the same configuration (`createMemory` does not accept a retention configuration). In DynamoDB, the three table names are empty or identical, or `snapshotAidIndexName` is empty. A mismatch with the `store_id` or `layout_version` recorded in the storage (P-40).
- The name of the "expiry mode" corresponds to the one in the specification (`retention_mode = ttl`). The type's name is `mode.type`.
- S-4, MEM-11: A retention failure does not change the result of the write. A `RetentionFailure` is passed to the `onRetentionFailure` callback and also output to `logger.error`. An exception thrown by the callback does not affect the result of the write and is output to `logger`. The shape of the public API is not fixed by the specification, so this shape is a design proposal.
- The same final failure is notified only once (this follows the conformance data's policy that observers may normalize multiple logs of the same failure into one).
- The current `shardCount`, `shardSelector`, `keepSnapshotCount`, `deleteTtlMillis`, `journalAidIndexName`, `snapshotActiveTtlIndexName`, `eventConverter`, and `snapshotConverter` are removed.

### 2.10 Mapping to the Current Public API

| Current (4.0.x) | Next (5.0.0) | Reason / rule |
|:--|:--|:--|
| `AggregateId { typeName, value, asString }` | `AggregateId { typeName, value }` and `AggregateId.of` / `AggregateId.asString` | T-1, T-11, T-12 |
| `Aggregate` (`version`, `withVersion`, `updateVersion`, `sequenceNumber`, `id`, `typeName`) | Removed. The domain value goes into `SnapshotEnvelope.aggregate` | T-10, ADR-0002, ADR-0004 |
| `Event` (`typeName`, `id`, `aggregateId`, `sequenceNumber`, `occurredAt`, `isCreated`) | `EventEnvelope` (`aggregateId`, `seqNr`, `occurredAt`, `manifest`, `payload`) | T-2, T-3, T-5 |
| `persistEvent(event, expectedVersion)` | `persistEvent(event)` | H-2, W-3, W-4, W-8 |
| `persistEventAndSnapshot(event, aggregate)` | `persistEventAndSnapshot(event, snapshot)` | 3.2, W-9 |
| `getEventsByIdSinceSequenceNumber(id, n): Promise<E[]>` (failure is an exception) | `getEventsByIdSinceSeqNr(aid, seqNr): Promise<Result<EventEnvelope[], EventStoreError>>` | R-4 to R-6, Chapter 4 |
| `getLatestSnapshotById(id): Promise<A \| undefined>` (failure is an exception) | `getLatestSnapshotById(aid): Promise<Result<LatestSnapshot \| undefined, EventStoreError>>` | R-1 to R-3 |
| `EventSerializer`, `SnapshotSerializer`, `converter` argument | `PayloadSerializer` | T-6, T-7 |
| `EventStore.createDynamoDB` (synchronous, exceptions) | Asynchronous, returns a `Result` | DY-8, Chapter 4 |
| `EventStore.createMemory({ events, snapshots })` (shares `Map` references) | Create the storage with `MemoryStorage.create({ retention })` and share it explicitly with `createMemory({ storage })` | MEM-2, MEM-3, MEM-6 |
| `EventStore.createSpanner` and the rest of the Spanner set | Not shipped in the first major | IP-D3 |
| `ShardSelector`, `ShardId`, `shardCount`, `DEFAULT_SHARD_COUNT` family | Removed | ADR-0006, DY-16 |
| `keepSnapshotCount`, `deleteTtlMillis` | `retention: { count, mode }` | S-1, DY-2, Chapter 8 |
| `journalAidIndexName`, `snapshotActiveTtlIndexName` | Removed. Only `snapshotAidIndexName` remains | D-3 |
| `EventStoreError` (4 classifications) | 5 classifications (`contract-violation` added). The arguments of the construction functions change | Chapter 4, E-1 to E-3 |
| `Logger` | Kept | S-4 |
| `Result` | Kept. Used as the return value of all operations (item 1 of Chapter 9) | — |
| Dependencies `aws-sdk` (v2), `moment`, `winston`, `@types/winston` | Removed. It has been confirmed that nothing in the TypeScript under `src` and `packages` references them | IP 4.2 |

## 3. Memory Implementation Approach

The location is `packages/library/src/next/internal/memory-event-store.ts` until the removal point (in PR 13 it moves to `src/internal/memory-event-store.ts` and replaces the current file; 2.1). The current one checks with the aggregate state's `version`, does not return an envelope-and-head pair, and shares references to events (memory.md Chapter 8). It is replaced entirely.

| Rule | Approach |
|:--|:--|
| MEM-1 | Single-process memory only. No persistence. No API for clearing everything during use is created |
| MEM-2 | `MemoryStorage.create()` creates empty, independent records. Only instances given the same `MemoryStorage` through `createMemory({ storage })` share the records, configuration, and mutual exclusion. Matching names do not cause sharing. The mutual exclusion is held inside `MemoryStorage` |
| MEM-3 | `MemoryStorage.create({ retention })` validates `retention` (count 0 and ttl) at creation and returns a configuration error. A change feed request (specifying `changeFeed`) is also checked at runtime and becomes a configuration error (2.9). The configuration is held immutably (`Object.freeze`) by the storage. `createMemory` does not accept configuration, and sharing instances use the storage's configuration |
| MEM-4 | One mutual exclusion per `MemoryStorage`. In JavaScript, objects cannot be shared across threads. Therefore a js storage is shared only within a single thread. Even when asynchronous calls overlap within the same thread, an asynchronous serialization queue (a mutex based on a Promise chain) is used so that intermediate states before commit are not exposed. This is how MEM-4 is satisfied (the js note in MEM-4 of the hub's memory.md, 2026-10-06). A storage that can be shared across threads is not created (item 3 of Chapter 9) |
| MEM-5 | The records are a `Map<string, aggregate record>` keyed by exact match on `AggregateId.asString`. `seqNr` is treated as a separate value (not concatenated). Aggregates are not identified by a hash alone and are not selected by prefix match. T-9, T-11, T-12, and T-13 are checked at the entry point. A plain object is not used as a dictionary (because inherited properties such as `"toString"` would leak in) |
| MEM-6 | Metadata and payload are held separately. The payload is converted to a `Uint8Array` with `serializer.serialize` on input and held (a copy is taken, not a `Buffer`), and restored with `deserialize` on retrieval. The stored value does not change even if the user modifies the payload after writing or modifies the retrieved result. No requirement beyond T-6 (such as cloneability) is imposed |
| MEM-7 | **Before** the mutual exclusion, input validation (T-9, W-6, W-9, T-11 to T-13) and payload serialization are finished. **Inside** the mutual exclusion, the head is read and checked (W-3, W-7, W-8), the change is prepared, published all at once (commit), and retention is run. A failure during preparation does not change the records. A new creation with seqNr=1 is possible with an event alone (no snapshot) |
| MEM-8 | `getLatestSnapshotById` reads the head and the snapshot inside the same mutual exclusion. `headSeqNr` and the envelope are values from the same point in time (R-8: atomic) |
| MEM-9 | `getEventsByIdSinceSeqNr` reads everything inside the same mutual exclusion and returns it in ascending order. Restoration may be done outside the mutual exclusion (after taking out the serialized `Uint8Array`) |
| MEM-10 | Without a retention count, only the current snapshot is held. With n, the newest n history entries are kept and the oldest are removed in order. This is done after commit, inside the same mutual exclusion. Even for an event-only append, leftover history is cleaned up. The journal and the head are not removed |
| MEM-11 | A retention failure does not change the success of the write. It is notified through `onRetentionFailure` and `logger` after the mutual exclusion is released. It is retried in the retention run after the next append (the excess is recomputed every time, so this is naturally a retry) |
| MEM-12 | A request for TTL mode is a configuration error |
| MEM-13 | No change feed is provided. If `changeFeed` is specified, `MemoryStorage.create` returns a configuration error (MEM-3) |

- "Commit" means assembling the new head, journal entry, and snapshot completely and then publishing them with a single assignment (replacement of the immutable records). No intermediate state before publication is visible to anyone (H-1, MEM-4).
- `Date` in MEM-6: as in 2.4, the time is recorded as a millisecond number.
- To cause retention failures in tests, there is an internal hook (a point to swap the retention processing) (5.3). It is not exposed in the public API.
- The conformance cases (memory.md Chapter 9) are verified by the runner in Chapter 5 and by rebuilding `memory-event-store.test.ts`.

## 4. DynamoDB Implementation Approach

The location is `packages/library/src/next/internal/dynamodb-event-store.ts` until the removal point (in PR 13 it moves to `src/internal/dynamodb-event-store.ts` and replaces the current file; 2.1). The current one has logical-shard keys (the pair of `pkey` and `skey`), a millisecond `occurred_at`, and behavior that turns a retention failure into a write failure. It is replaced entirely.

### 4.1 SDK

- `@aws-sdk/client-dynamodb` (v3). The current range is `^3.413.0`, and the lock file resolves 3.1146.0. The minimum version is raised to one whose types include `ReturnValuesOnConditionCheckFailure` (D-5) and the `Item` of `CancellationReasons` in `TransactionCanceledException` (the minimum version to use is confirmed and decided at implementation time; unverified).
- `@aws-sdk/lib-dynamodb` is not used. Attribute types (S/N/B/L/M) are specified explicitly, and numbers are handled as the string `N` (for BigInt conversion).
- `aws-sdk` (v2) is removed.
- Injection mechanism: the SDK v3 **middleware stack** (`client.middlewareStack.add`) is used. Described in 5.4.

### 4.2 Three Tables and Configuration Items (DY-8, P-19, P-40)

| Table | Key | Notes |
|:--|:--|:--|
| journal | PK `aid`(S), SK `seq_nr`(N) | No GSI, Streams disabled |
| snapshot | PK `aid`(S), SK `skey`(N) | GSI `(aid, active_history_seq_nr)`, KEYS_ONLY (D-3). TTL attribute `ttl` (enabled only in TTL mode, DY-2) |
| head | PK `aid`(S) | Streams enabled, NEW_IMAGE (DY-3, DY-12, D-4) |

- The PK is `AggregateId.asString` itself (DY-16). The SK is `seq_nr` for the journal, and for the snapshot it is currently 0, with history entries using their seq_nr (DY-17).
- The three tables are in the same region. Reads are strongly consistent (DY-18). The operations used are limited to those scoped by aid (DY-19). `Scan` is not used.
- Creating the three tables is outside the library. In tests, the test side creates them (Chapter 6).

Steps at creation time (`createDynamoDB`):

1. On every creation, read the three `__config__` configuration items (`seq_nr=0` for the journal, `skey=0` for the snapshot, no SK for the head) with a single `BatchGetItem` (`ConsistentRead=true`).
2. For `UnprocessedKeys`, re-request only those keys with exponential backoff, still strongly consistent. `Responses` are accumulated. Absence is not concluded until nothing remains unprocessed. When the re-request limit (`retryLimit`, not counting the first request) is reached, return a **storage error** (not a configuration error). Design decision: the limit is held as a count, the default is 5 (matching the current limit on retention retries), the initial backoff is 50 ms, and the upper limit on a single wait is 1000 ms (doubling each time). The waiting can be swapped through the internal hook `sleep` (5.3). The conformance data `dynamodb-config-retry-exhausted` returns unprocessed responses twice with `retry_limit: 1`. Unprocessed keys remain after the first re-request, so the storage error is returned on reaching the limit and the `configuration-create` request is not sent.
3. If none of the three exists, create a new `store_id` (a random value) and issue three `Put`s conditioned on `attribute_not_exists(aid)` in a single `TransactWriteItems`. The only attributes are `store_id`(S) and `layout_version`(N, 1). The snapshot's configuration item has no `active_history_seq_nr`. If the condition fails (another runner created them first), discard the response, re-read the three with strong consistency, and proceed to step 4. The same re-read happens when the cancellation reason is `TransactionConflict` (another runner is writing at that moment). If none of the three exists even after re-reading, return a storage error without repeating the creation (DY-8, P-44). The conformance data has no such situation, so unit tests check both the case where the configuration items are found by the re-read and the case where none of the three exists and a storage error results.
4. If all three exist, `store_id` matches across the three, and `layout_version` equals its own version (1), continue.
5. Otherwise (only some exist, `store_id` mismatch, `layout_version` differs), it is a configuration error (P-40).
- The required IAM permissions are `dynamodb:BatchGetItem` and `dynamodb:PutItem` on the three tables. Configuration items are created only with a conditional `Put` (never updated or deleted).

### 4.3 Writes (D-5, D-6, D-7, W-8, H-1 to H-4)

One write is one `TransactWriteItems`. There are at most four actions:

1. `Put` to the journal (condition `attribute_not_exists(aid)`). Attributes are `aid`, `seq_nr`, `occurred_at` (N, epoch nanoseconds), `manifest`(S), and `payload`(B).
2. Head: a new creation (`seqNr = 1`) is a `Put` (condition `attribute_not_exists(aid)`). An update is an `Update` (condition `seq_nr = :prev`, `:prev = event.seqNr − 1`; overwrites `seq_nr` and `events`). The head's `events` is an `L` with one element (the element is an `M`: `seq_nr`, `occurred_at`, `manifest`, `payload`). It also holds `type_name`(S).
3. If there is a snapshot, `Put` to the current snapshot (`skey = 0`, no condition). `last_updated_at` is the millisecond value of `occurred_at`.
4. If a retention count is configured, `Put` to the history snapshot (`skey = seq_nr`, no condition). It holds `active_history_seq_nr` only while it is not marked.

Correspondence to the rules:

- **D-5**: Attach `ReturnValuesOnConditionCheckFailure = ALL_OLD` to the head action. Compare the `seq_nr` of the old item in the head element of `CancellationReasons` of `TransactionCanceledException` with `event.seqNr` (no additional read). If no old item is returned, the head is regarded as 0.
- **W-8 (update)**: For the old head `h`, `event.seqNr ≤ h` is an optimistic lock and `event.seqNr ≥ h + 2` is a contract violation (gap). A `seqNr ≥ 2` for an aggregate without a head is regarded as head 0 and is a contract violation (gap).
- **W-3**: If the head condition fails on a new creation, it is an optimistic lock.
- **W-7**: If the journal condition fails, it is an optimistic lock.
- **D-6**: `TransactionConflict` is classified as an optimistic lock. Throttling other than on the head, and communication failures and others, are storage errors.
- When `CancellationReasons` has multiple reasons, look at all of them. If any item's reason is `TransactionConflict`, it is D-6 (optimistic lock). Next, classify the head's `ConditionalCheckFailed` by D-5 (W-3, W-8), and treat the journal's `ConditionalCheckFailed` as W-7 (optimistic lock). Other throttling is a storage error. This order was fixed by the specification (`dynamodb.md` 6.2, P-43; 2026-10-06). The conformance data has no situation where reasons attach to multiple items, so unit tests check it (example: the head's condition failure indicates a gap while another item returns `TransactionConflict`, which results in an optimistic lock).
- **D-7**: Before writing, estimate all items to be written: the journal item, the head item (including `aid` and `type_name`; `payload` appears in both the journal and the head), the current snapshot item, and the history snapshot item. If even one exceeds 409600 bytes, send nothing and return a contract violation (`rule: "D-7"`) (the conformance data's `no_requests_in_phases` includes `commit` and `retention-*`). Use the DynamoDB item size calculation rule, including attribute names and type tags. The four conformance cases (`dynamodb-item-size-event`, `-snapshot`, `-manifest`, `-head-overhead`) each check an excess in a different item.
- **T-3**: Write `occurred_at` as the decimal string of `BigInt(date.getTime()) * BigInt(1000000)` in an `N`. When reading, receive it as BigInt and convert it back to a millisecond `Date`. No floating point is involved. The current `tsconfig` has target es6, so do not use BigInt literals (`1n`); use the `BigInt()` function. The `lib` in `packages/library/tsconfig.json` is `ESNext`, so there is no need to add `lib` for the `BigInt` type.
- **H-1**: The head, journal, and snapshot are committed in one transaction. The only source of the change feed is the head's Streams (the journal's Streams are not used).
- Retention processing (4.5) is run **after** the transaction commits (D-9).

### 4.4 Reads (DY-9, DY-10, DY-11, R-8)

- `getLatestSnapshotById`: read the head item and the current snapshot (`skey = 0`) in a single `BatchGetItem` (strongly consistent) (DY-9). `UnprocessedKeys` are re-requested until fully read. The re-request covers only the remaining keys, with exponential backoff and still strongly consistent, and the limit and wait times are the same as for reading the configuration items (4.2) (`retryLimit`; default 5; the first request is not counted). When the limit is reached, unprocessed keys are not judged to be "absent" and a storage error is returned (design decision. DY-9 defines no limit, but without one the call might never finish). If there is no head, the result is `undefined`; if there is one, it is a pair of an envelope (which may be absent) and `headSeqNr` (DY-10). Reading the two items is **not atomic** (R-8). `TransactGetItems` is not used (P-25).
- `getEventsByIdSinceSeqNr`: `Query` the journal with `aid = :aid AND seq_nr >= :seq_nr` and `ConsistentRead = true`. Results are in ascending order, and reading continues while `LastEvaluatedKey` is returned (DY-11, R-5).
- Items that cannot be restored (missing required attributes, or `payload` that is not `B`) are a **storage error** (missing data in what was read). A failure to restore through serialization is a serialization error.

### 4.5 Retention Processing (Chapter 8, D-3, D-9, P-18, P-24, S-2, S-3, S-4)

Run only **after** a write that wrote history has committed (D-9).

1. `Query` the sparse GSI with `aid = :aid` and `ScanIndexForward = false`, and read it all (KEYS_ONLY).
2. Add the history just written (do not duplicate it if it is already visible in the GSI), keep the top n in descending order, and make everything older the target (S-2).
3. Delete mode: `BatchWriteItem` in groups of 25 (P-18). For `UnprocessedItems`, resend only the remaining items with exponential backoff. The limit and wait times are the same as for reading the configuration items (4.2) (`retryLimit`; default 5; the first request is not counted). When the limit is reached, the rest is not deleted and is notified as a retention failure, and the result of the write does not change. The remaining history becomes a target again in the next retention run (design decision. The specification only defines that items are resent and defines no limit. Because retention runs inside the write call, without a limit the call might never finish).
4. TTL mode: one `UpdateItem` per item. `SET #ttl = :expires REMOVE active_history_seq_nr`, with the condition `attribute_exists(active_history_seq_nr)`. `#ttl` goes in `ExpressionAttributeNames` (because `ttl` is a reserved word). `:expires` is the epoch seconds at the time of marking plus the grace seconds. The sum can exceed 2^53, so compute it with `BigInt` and write it to the N attribute as a decimal string (adding as `number` loses precision). A unit test checks the boundary where the grace seconds are `Number.MAX_SAFE_INTEGER`. If a later update fails its condition, it is skipped as already marked.
5. The approach of counting first and then selecting the excess is not used (P-24). Marked history is not counted toward the count, and the expiry is not postponed (S-3).
- A failure does not change the result of the write (S-4). It is notified through `onRetentionFailure` and `logger`. The current behavior in `dynamodb-snapshot-retention-executor.ts` of turning a retention failure into a write failure is replaced.
- The current `deleteTtlMillis` (milliseconds) is replaced by `graceSeconds` (seconds; the `ttl` attribute is epoch seconds).

### 4.6 Change Feed

Not included in the first major (owner's decision, 2026-10-06). Enabling the head's Streams is done on the table side, and the library only writes while keeping the shape of DY-3 and DY-12 (the head has Streams enabled with NEW_IMAGE, and the journal's Streams are not a source). The function that assembles head transitions (DY-13) and the resynchronization helper (DY-15) are not shipped.

## 5. Conformance Test Data Runner

### 5.0 Location and How to Run

- The runner is placed in `src/internal/test/conformance/` (internal; not public. Until the removal point, `packages/library/src/next/internal/test/conformance/`, 2.1). This is so it can reach the library's internal modules and hooks without increasing the public API. `internal/test/` is deleted by the current `scripts/remove-test-artifacts.mjs` (`dist/internal/test`), so it is not part of what is shipped, and it is also covered by the coverage exclusion in `jest.config.ts` (`!src/internal/test/**`). `src/next/internal/test/` until PR 13 is covered by neither setting. Therefore in PR 2, `next/internal/test` is added to the deletion targets of `remove-test-artifacts.mjs` and to the exclusion of `jest.config.ts`. When it moves to `src/internal/test/` in PR 13, this addition is removed.
- It is run from Jest (the current test infrastructure). One test file (`conformance.test.ts`) reads all files in `conformance/` and creates tests dynamically per case. It runs for each storage (Memory, DynamoDB). The runner does not depend directly on the library's types and has its own boundary interface (store creation, the four operations, envelope construction, hooks). The mapping to this interface is added in each PR in Chapter 7.
- `conformance/` is copied with the same contents as the hub. The runner does **not rewrite** `conformance/`.

### 5.1 How to Read the Data

| Topic | Approach |
|:--|:--|
| Loading | UTF-8 JSON. Check the top-level `format` and `version`. Detect duplicate keys and fail. The standard `JSON.parse` does not detect duplicate keys, so the plan is to rely on `manifest.py verify` passing and also check in the runner itself (to be confirmed at implementation) |
| Arbitrary-precision integers | Read `-1` and `2^53` of `seq_nr` as generic JSON values. Numbers are read with the `context.source` of the `JSON.parse` reviver (whether it is available in Node.js 24 is unverified) or with a custom lexer. They are not converted directly to `number`. Only `seq_nr` and time (`epoch_nanoseconds`, computed as `bigint` from a decimal string) become `bigint`. Payload numbers remain `number` and are treated as JSON values. Making even payloads `bigint` would make `JSON.stringify` fail (`core-seq-above-max` also has `9007199254740992` in its payload) |
| Conversion to types | Convert from `bigint` to `number` with `Number(x)` and check that it converts back exactly with `BigInt(Number(x)) === x`. Values that do not convert back (such as odd numbers above 2^53) cannot be passed to the library's checks, so they are reported as "not representable". 2^53 itself (the value one above `Number.MAX_SAFE_INTEGER`) is exactly representable as a `number`, so it is executed as exceeding the T-9 upper bound. The T-9 contract violation is checked in envelope construction and comes out before serialization (`JSON.stringify` of the payload). Therefore the payload `9007199254740992` does not become a serialization failure |
| Time | Read `occurred_at` as UTC ISO 8601 with nine fractional-second digits and convert it to `bigint` epoch nanoseconds |
| Precision policy | For success cases with `precision_policy = native-time-type`, the expected value is the input converted to `Date` (milliseconds). The runner reports the converted value and the actual value. Design decision: the conversion uses `BigInt` floor division (rounding toward negative infinity). `/` on `BigInt` truncates toward zero, so after `q = ns / 1000000n`, a correction `q - 1n` is applied when `ns % 1000000n < 0n` (the −1 nanosecond of `occurred-at-before-epoch` becomes −1 millisecond). It is decided in one place inside the runner. Cases with `representation.time_precision = nanoseconds` (in the actual data, 4 in the value table and 4 in the scenarios) are not applicable and are reported with the reason "Date has millisecond precision". Cases with `milliseconds` (likewise 4 and 4) are executed. Cases without the marker are executed by all implementations |
| Negative numbers | `representation.signed_seq_nr = true` is executed (`number` can represent negative values) |
| Operations in the value table | `buildAid` is `AggregateId.of` and `AggregateId.asString`. For `user_string`, a test ID that returns the user's alternative representation (a value whose `asString` and `toString` return different strings) is passed in the same shape as `AggregateId`, and the test checks that the library builds the string from the type name and value without using it. `validateSeqNr` is `EventEnvelope.create` (`context=event`) and an internal function that checks only the value range (`context=value`). `validateOccurredAt` uses `EventEnvelope.create` and calls `persistEvent` following the case's steps (type name `ConformanceTime`, value is the case ID). The four `fnv1a64` cases are reported as not applicable (counted neither as success nor as failure) because the first major has no storage that uses hashes. They are executed when a storage using hashes is shipped in stage 5 (owner's decision, 2026-10-06, implementation plan Chapter 5 item 1) |
| Payload comparison | Compare values restored with the default JSON while ignoring key order and whitespace. Array order, `null`, booleans, strings, and numbers are preserved. Booleans and numbers are not equated. No Unicode normalization |
| generators | Expand the empty-string `target` (JSON Pointer) by repeating `character` (one Unicode character) until `byte_length` (total UTF-8 bytes) is reached (`byte_length` ÷ the UTF-8 width of the character times; a specification that does not divide evenly fails as a data error). Decode `~0` and `~1`. Schema validation is before expansion, and operations are after expansion. The reference implementation is `materialize` in `tools/conformance/data.py` |
| Sizes | 400KB is 409600 bytes, and 1MB is 1048576 bytes |

### 5.2 Scenario Execution Steps and Store Isolation

Each scenario runs on an independent store. The steps follow `conformance/README.md`.

1. Check that `backends` includes the storage being run. `requires = ["ttl"]` is not applicable to Memory (MEM-12; the TTL scenarios in v1 are DynamoDB only).
2. Create the store from the `store` configuration. `retention_count = null` means no history. `retention_mode` (delete / ttl) and `ttl_grace_seconds` are mapped to `SnapshotRetention`. For Memory, pass it to `MemoryStorage.create({ retention })` and create the store with `createMemory({ storage })`. DynamoDB runs a configuration-item `BatchGetItem` on every creation (4.2).
3. If there is `seed.items`, insert them with test privileges (the runner's own client) before creating the store.
4. If there is `initialization`, check the creation result. Cases where creation fails have no operation sequence. Faults before creation are registered first (`operation = 0`; registration and consumption are in 5.4).
5. Expand generators, and construct `fixtures.events` and `fixtures.snapshots` as envelopes just before each operation. Rule violations during envelope construction for invalid input are also caught as failures of that operation. The runner's pre-checks do not substitute for the library's checks.
6. Run `steps` in array order, without running them concurrently.
7. Check each operation's `expect` and `observe`. For scenarios with retention failures or delays, observe after the retention and check hooks have completed. The hooks do not change the success or failure of the write.
- `retry_limit` is the limit on the number of re-requests in configuration verification (the first request is not counted). It maps to `DynamoDBEventStoreInput.retryLimit`. For exponential backoff, the clock hook (swapping `sleep`) may be used to shorten the real time.

**Store isolation for DynamoDB**: for each scenario, the runner creates the three tables and the GSI anew. Table names are unique per scenario, like `conf-<sequence>-<random>-journal`, and the three tables are created in the same region. The GSI name may be fixed because tables differ per scenario and there is no collision. At the end of the scenario, the three tables are deleted. Items from other cases are not reused. Creation is done by the test side's `CreateTable` (rebuilding the current `dynamodb-utils.ts`). Since items from other cases are not reused, separate tables are used per scenario. Whether the creation cost on DynamoDB Local (43 of the 85 scenarios are DynamoDB) fits within the CI constraints is checked by execution time (unverified).

**Store isolation for Memory**: for each scenario, new records are created with `MemoryStorage.create()`.

### 5.3 Where the Hooks Live

Hooks are passed as the second argument of the internal creation functions (`createDynamoDBEventStoreInternal(input, hooks)`, `createMemoryEventStoreInternal(input, hooks)`). The public `EventStore.createDynamoDB` calls the internal function without hooks.

| Hook | Location |
|:--|:--|
| Deterministic run of retention | Internal hook `retentionScheduler`. Normally it runs immediately after the write commits. The runner receives a run whose completion can be awaited (a `Promise` that can be `await`ed) and waits for it before `observe`. The library returns the retention processing internally as a `Promise` |
| Inspecting internal history (`observe.history`) | DynamoDB: with the runner's client, `Query` (strongly consistent) the snapshot table items for that aggregate and classify them into active (has `active_history_seq_nr`) and marked (has `ttl`). The current snapshot (`skey = 0`) and the configuration item are not counted. Memory: an internal accessor that reads the internal logical history |
| Inspecting failure notifications (`observe.notifications`) | Record what `onRetentionFailure` receives. If there are multiple logs of the same final failure, normalize them into one |
| Inspecting SDK requests (`observe.requests`) | The middleware (5.4) records the input assembled at the `build` stage. Expressions are parsed and compared by the structure of the expression and the bindings of attribute names and values (whitespace, clause order, and AND order are not compared) |
| Inspecting attributes (`observe.items`, `seed.items`) | `GetItem` with the runner's client. Checks on attribute set, type, and list length are done on the whole actual item before exclusion, and the attribute set is compared for exact match. `N` is compared as an integer from the decimal string. `binary_json` compares the restored result of `B` as JSON. An `M` inside an `L` is `nested_attributes`. The binding of `generated-store-id` binds the first actual `store_id` and checks that the three items (the configuration items of journal, snapshot, and head) have the same value |
| Clock | Internal hook `clock` (`() => epochSeconds`). The expiry of TTL marking becomes "marking time + grace seconds". In v1 it is a clock set to the year 2100 |
| Waiting (DY-8 backoff) | Internal hook `sleep` (`(ms: number) => Promise<void>`). The default waits in real time. The runner swaps it for a function that records the wait and returns immediately, shortening the real time of exponential backoff (4.2) |
| Layout verification (`dynamodb/layout.json`) | The runner verifies the three created tables with `DescribeTable` and `DescribeTimeToLive`. It also verifies the keys, the GSI projection (KEYS_ONLY), Streams only on the head (NEW_IMAGE), and the TTL state of the snapshot. Table names and GSI names are bound to configuration values |
| SDK request size check | For D-7, `no_requests_in_phases` checks that no `commit` or `retention-*` requests are sent when any of the four items (4.3) exceeds the limit |

### 5.4 Where the SDK Injection Happens

For DynamoDB, injection is done through middleware that the runner adds to `DynamoDBClient.middlewareStack`.

- Position (design decision): fixed to a single place, the `build` stage (after the input is assembled, before signing and retry). Observing SDK requests and injecting `replace-request` and `replace-response` are both done in middleware at the same stage. To **disable automatic retries**, the client the runner creates uses `maxAttempts: 1`. Whether injection at the `build` stage is possible is checked by a small prototype in the first implementation PR (unverified).
- `replace-request`: the middleware does not call `next` and returns an exception or a response. Nothing is committed. All write failures and retention failures in v1 are of this kind.
- `replace-response`: after calling `next`, the response is replaced. Side effects remain.
- Only retention requests are made to fail (IP 6). The middleware narrows the target by command name and by the target table and GSI (`IndexName` of `QueryCommand`, `BatchWriteItemCommand`, the target of `UpdateItemCommand`). The write transaction is not made to fail.
- The `TransactWriteItems` at creation (stage `configuration-create`) and the `TransactWriteItems` of a write (stage `commit`) are distinguished by operation number. Creation is `operation = 0`, and writes are 1 or more. The middleware holds the operation number the runner is currently executing, and injects only into requests where both the registered fault's `operation` and the stage match.
- The middleware is not placed in the library itself. The library uses the client it is given as it is.

#### Registering, Consuming, and Checking for Unfired Faults (Common Mechanism)

The runner holds one fault registry. There are three injection points, and all use the same registry.

| Injection point | Target stages |
|:--|:--|
| SDK middleware (`build` stage) | `commit`, `read-events`, `read-snapshot`, `retention-*`, `configuration-*` |
| Serializer wrapper (a function that wraps `PayloadSerializer`) | `serialize-event`, `serialize-snapshot`, `deserialize-event`, `deserialize-snapshot` |
| Memory internal hooks | `commit`, `read-events`, `read-snapshot`, `retention-*` |

- Registration: register all of the scenario's `faults` per operation number (0 is creation) and stage. Faults of different stages are all registered at the same time. Faults before creation (`operation = 0`) are registered before the store is created.
- Consumption: faults with the same operation number and the same stage are consumed one at a time in array order. Each time a request or call arrives, the injection point looks up a matching fault in the registry and fires it.
- `repeat`: `{ "mode": "count", "count": n }` becomes consumed after firing n times. `{ "mode": "until-operation-finishes" }` keeps firing until that operation finishes, and becomes consumed when the operation ends.
- Check for unfired faults: at the end of an operation (for creation, the end of creation), if any registered fault for that operation number has never fired, the scenario fails. `until-operation-finishes` must also fire at least once. A stage that could not be injected is not counted as a success and is reported as "unverified" (5.5, 5.8).

### 5.5 Fault Injection (12 Stages)

There are 12 kinds of `phase` (the enumeration in `conformance/schema/common.schema.json`; the 13 in the instructions was the lead's mistake).

| Stage | DynamoDB | Memory |
|:--|:--|:--|
| `serialize-event` | Wrap the event serializer and make `serialize` fail | Same (it fails before the mutual exclusion, so the records do not change) |
| `serialize-snapshot` | Wrap the snapshot serializer | Same |
| `deserialize-event` | Make the event serializer's `deserialize` fail | Same |
| `deserialize-snapshot` | Make the snapshot serializer's `deserialize` fail | Same |
| `commit` | Middleware for `TransactWriteItems`. `replace-request` (including assembling `TransactionCanceledException`) and `replace-response`. `cancellation_reasons` is in 5.7 | Fail with an internal hook just before commit (before the all-at-once publication). No change is left in the head, journal, or snapshot. There is no SDK exception, so the `sdk-error` family **cannot be injected** (reported as unverified. Instead, the `storage-error` case checks that the records do not change on a failure before commit) |
| `read-events` | Middleware for `QueryCommand` (journal) | Internal hook just before the read |
| `read-snapshot` | Middleware for `BatchGetItemCommand` (including the response plan of `sdk-response` and `read-interleave`) | Internal hook just before the read. `read-interleave` is not applicable because R-8 is atomic (reason recorded) |
| `retention-query` | Middleware for the GSI's `QueryCommand` (including the response plan of `history_pages`) | Hook for enumerating the logical history. `history_pages` replaces the enumeration of the logical history. It returns the history seq_nrs of the page sequence concatenated (the history just written is not added automatically). Adding the history just written and removing duplicates is done by the library's code (the same processing as step 2 of 4.5). Memory has no paging, so `LastEvaluatedKey` and `ExclusiveStartKey` are not mapped. The result of selecting retention targets is checked with `observe.history` |
| `retention-delete` | `BatchWriteItemCommand` (including `unprocessed_first_n`) | Hook for deleting the logical history. The splitting of `BatchWriteItem` and `unprocessed_first_n` do not exist (DynamoDB only) |
| `retention-mark` | `UpdateItemCommand` (TTL marking of the snapshot) | **Not applicable** because there is no TTL (MEM-12) |
| `configuration-read` | `BatchGetItemCommand` at creation (`unprocessed_keys`) | **Not applicable** because there is no reading of configuration |
| `configuration-create` | `TransactWriteItemsCommand` at creation (including creation races through `install_items`) | **Not applicable** because there is no creation of configuration |

- There are 11 fault cases that include Memory in `conformance/scenarios/core/retention-errors.json` (the range confirmed by scanning `conformance/`). Four specify `history_pages` of `retention-query`: `core-retention-delete-1`, `core-retention-delete-2`, `core-retention-failure-after-commit`, and `core-retention-query-failure`, and they are injected with the mapping above. The remaining seven are `core-serialize-event` (`serialize-event`), `core-serialize-snapshot` (`serialize-snapshot`), `core-deserialize-event` (`deserialize-event`), `core-deserialize-snapshot` (`deserialize-snapshot`), `core-storage-commit-failure` (`commit`), `core-storage-read-events` (`read-events`), and `core-storage-read-snapshot` (`read-snapshot`), all of which are injected with the hooks in the Memory column of the table above. If a stage other than these that cannot be injected into Memory appears among the executed targets, it is reported as "unverified" with the reason and is not aggregated as a success.
- Handling of `kind`: `serialization-error` makes the serializer's corresponding stage fail. `storage-error` is the final failure of the storage or retention hook. `details.scope = final-retention-failure` makes the whole retention fail after candidate selection and before deletion. The hook position is, in DynamoDB, between step 2 (selecting targets) and step 3 (deletion) of 4.5, and, in Memory, just before the logical-history deletion hook. `omit_just_written_history` exists only for DynamoDB (it creates a situation where the GSI does not yet return the history just written). Memory is not applicable. `sdk-error` builds the SDK exception class (such as `TransactionCanceledException`) from `details.code` and `cancellation_reasons`. `sdk-response` is a response plan. `read-interleave` is the non-atomic response of DY-9.
- `read-interleave`: capture the old head just before sending, commit the append of `interleaved_operation`, send the original `BatchGetItem`, and replace the head in the response with the old head. Real-time races are not used. The runner performs the append with a different store instance.
- The handling of `repeat` follows the common mechanism in 5.4.

### 5.6 Checking `observe.requests`

- Expressions are decomposed into the structure of `SET`, `REMOVE`, and condition expressions by a small parser inside the runner. Whitespace, clause order, and AND order are not compared.
- Check `key_condition.all` (`eq` / `gte` and the bindings of `aggregate_id` and `seq_nr`), TTL's `#ttl` and `ExpressionAttributeNames`, `expires` (epoch seconds), `initial_batch_sizes` (the number of deletion batches excluding resends), `no_requests_in_phases`, `request_count`, and `minimum_request_count`.
- The elements of `requests` are matched, in array order, to distinct actual requests. Paging, re-requests of unprocessed keys, and splitting of deletion batches are checked across the whole request sequence of the stage.

### 5.7 `cancellation_reasons`

One element per action of the transaction. For writes, the order is journal, head, current-snapshot, history-snapshot (only the actions that exist). For configuration creation, they are `configuration:journal`, `configuration:snapshot`, and `configuration:head`. The `Code` of an element that did not fail is the string `None`. The runner matches target names to the actual actions in the request and reorders them (the library's request order is not enforced). The head's `ConditionalCheckFailed` has `old_head_seq_nr` (`null` means no old item is returned). The D-5 classification uses this old item. The library's classification looks at all reasons as in 4.3 (a `TransactionConflict` on any item is D-6).

### 5.8 Reporting and CI

- Report form (both JSON and a summary to Jest's standard output):
  - The data version and the result of verifying `manifest.json`.
  - The language (`typescript`), the implementation version (the version in `package.json`), and the storage (`memory` / `dynamodb`).
  - Results per case ID and rule number, in five kinds: `passed` / `failed` / `not-applicable` / `unverified` / `not-representable`. Cases marked for nanosecond precision and the four `fnv1a64` cases are reported as `not-applicable` with reasons. Values that a `number` cannot represent are reported as `not-representable`.
  - The failed operation number, with the expected and actual values.
  - Reasons for selection, optional capabilities, removed rules, and caller recommendations that arise from differences in representational capability.
- If one case has multiple rules, it is mapped to all of them. If the result differs from the expectation partway, it is not reported as a success (IP 5). Cases whose conditions are not met, results where required cases were skipped, and results where faults could not be injected are not aggregated as successes.
- The names for result representation match the terms in `conformance/README.md`. If the terms differ, the README takes priority (to be confirmed at implementation).
- Distribution verification: keep the existing `python3 tools/conformance/manifest.py verify` in the current CI's `release-checks`, and the check against the SHA-256 of `manifest.json` (for v1.0.0, `61c26614dbbfba88eebce72cc1d2b0220218839e74dcfb64c19268f7ee2302ce`). Do not regenerate the manifest to hide differences. `conformance/.gitattributes` stops newline conversion.
- Execution: include it in `pnpm --filter event-store-adapter-js run coverage --runInBand` (the current `test` job). DynamoDB Local is started inside the tests by Testcontainers (Chapter 6). If the run time is long, split it into a dedicated job.

## 6. Test Environment

### 6.1 DynamoDB Local 3.3.1

- Image: specify `amazon/dynamodb-local` with the digest `sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab` (3.3.1, pinned on 2026-10-05).
- How to start: use the current Testcontainers (`GenericContainer`, in the form of the current `packages/examples/src/dynamodb-container.ts` and `packages/library/src/internal/test/dynamodb-utils.ts`). The image is specified as `amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab`.
- The port is 8000. Readiness is confirmed by waiting for the port to listen (`Wait.forListeningPorts()`), without depending on log wording.
- Startup options: running in memory (`-inMemory`) and the shared database (`-sharedDb`) are unnecessary because tables are separated per scenario. The region and access keys are fixed dummy values (for tests only).
- Specify `endpoint` **explicitly** on the client. Also specify the same `endpoint` explicitly on the Streams client. The region in the Streams ARN is `ddblocal` and must not be inferred from the ARN (hub's `docs/plan/implementation-plan.md` 4.1).
- How DynamoDB Local handles TTL (actual expiry deletion may not happen) has no effect, because the TTL expiry check is done on the attribute value (epoch seconds in `ttl`). Whether enabling TTL (`UpdateTimeToLive`) is accepted and can be read with `DescribeTimeToLive` is checked by the verification in `dynamodb/layout.json` (unverified).

### 6.2 How to Move from the Current Tests (LocalStack)

| Target | Current state | How to move |
|:--|:--|:--|
| `packages/library/src/internal/dynamodb-event-store.test.ts` | LocalStack (`localstack/localstack:2.1.0`, port 4566) | Keep it on LocalStack until the old implementation is removed (PR 13). Tests for the new DynamoDB implementation are newly created in `src/next/` and run on DynamoDB Local. The old test is removed in PR 13 |
| `packages/library/src/internal/test/dynamodb-utils.ts` | `CreateTable` for the old layout (journal and snapshot, `pkey`, etc.) | Keep until the old implementation is removed. `CreateTable` for the new layout (three tables and the GSI) is newly created in `src/next/internal/test/`. The port is 8000 |
| `packages/library/src/internal/test/user-account-repository.test.ts` | LocalStack | Keep until the old implementation is removed (PR 13). The equivalent test for the new API is newly created in `src/next/` and runs on DynamoDB Local |
| `packages/examples/src/dynamodb-container.ts` | LocalStack | Move to DynamoDB Local and the new API in PR 12, which moves the consumers |
| `packages/examples/README.md` | Description of LocalStack | Updating the documentation is at the end of the stages (the documentation PR for 5.0.0). Not touched this time |
| Dependency `testcontainers` | `^12.0.0` | Kept |

- Period of handling LocalStack (design decision): the tests of the old implementation (LocalStack) are not removed until the old implementation is removed (PR 13). Tests of the new implementation (DynamoDB Local) are added from PR 9. From PR 9 to PR 12, both LocalStack and DynamoDB Local remain in CI. In PR 12, `examples` and `packages/tests` move to DynamoDB Local, and in PR 13 the LocalStack dependency disappears.

## 7. Bringing It into main

### 7.1 Policy

Follow the approach in Chapter 3 of the implementation plan. Squash-merge into main per PR. The main Snapshot is published with the next major's version (`5.0.0-snapshot.*`). The major is published manually after the acceptance conditions (IP 5) are met and the owner's approval is obtained. The worker's job ends at creating the PR, and the coordinator does the merge (IP 9).

### 7.2 How to Keep Main's CI Passing in Each PR

The current CI consists of `lint`, `test` (build and coverage), `examples` (`pnpm run test:examples`), `package-tests` (`pnpm run test:packages`), `release-checks`, and the aggregate `ci-success`. Each PR passes all of them.

- `examples` and `package-tests` use the public API. Up to PR 12 they pass with the old API as is. In PR 12 they move to the new API. `packages/tests` depends on the workspace's library through `workspace:*` and does not depend on the published version.
- Locations of old and new (design decision): the new core, Memory, and DynamoDB are created in `packages/library/src/next/` with the same file names as the final names (2.1). Names do not collide with the files in the current `src/`. Up to PR 12, `index.ts` does not expose `src/next/`. `src/next/` is verified only by internal tests. In PR 12, `index.ts` is repointed to `src/next/`. In PR 13, the old implementation is removed and the contents of `src/next/` are moved to `src/`.
- There is **no public coexistence** of the old API and the new API. Coexistence is an internal work-in-progress state between PR 1 and PR 11.
- New tests run on DynamoDB Local. This requires running Docker in CI (the same premise as the current LocalStack).

### 7.3 Sequence of PRs

One PR corresponds to one group of rules.

| PR | Scope | Corresponding rule group | Notes |
|:--|:--|:--|:--|
| PR 1: Preparation | Set the version in `packages/library/package.json` to `5.0.0-snapshot.0` (publishing the Snapshot then becomes `5.0.0-snapshot.<run>.<attempt>` through `replace(/-snapshot\.\d+$/, "")` in `snapshot.yml`). Remove unused dependencies (`aws-sdk`, `moment`, `winston`, `@types/winston`) and update `pnpm-lock.yaml` | None (IP-D1, IP 4.2) | Does not change code behavior. The version-bump workflow (`bump-version.yml`) is started only manually (`workflow_dispatch`), and it has been confirmed that `level` includes `major`. Maintenance of 4.x (maintenance branch, CI targets, version-bump handling, `--tag`) is done when it becomes necessary, as in implementation plan Chapter 3 |
| PR 2: Foundation of the conformance runner | Loading data, running scenarios, reporting, `manifest` verification, the location of hooks (`src/next/internal/test/conformance/`). Widen the exclusions in `remove-test-artifacts.mjs` and `jest.config.ts` to `next/internal/test` (5.0). The runner depends only on its own boundary interface (5.0) and not on the core types. Unit tests for the runner | 5.1, 5.2, 5.8, IP 5 item 1 | Keep the order of implementation plan 4.2 (runner → core). Running each case is enabled in Memory (PR 8) and DynamoDB (PR 9 to 11) |
| PR 3: Core (value types) | Aggregate ID, event envelope, snapshot envelope, integer and time types | T-1 to T-5, T-9 to T-13 | Not exposed from `index.ts` |
| PR 4: Core (payload and errors) | `PayloadSerializer`, `EventStoreError` (5 classifications) and construction functions | T-6 to T-8, E-1 to E-3 | |
| PR 5: Core (operations) | The `EventStore` type and the entry-point checks for writes and reads | Entry-point checks for T-2, T-10 and W-3 to W-9, R-1 to R-6 | Checks against the storage belong to each storage's PR |
| PR 6: Core (configuration) | `SnapshotRetention`, `RetentionFailure`, input types and validation | S-1, S-4 (types) | |
| PR 7: Memory implementation | The new Memory implementation (`MemoryStorage`, mutual exclusion, retention processing) and its unit tests | MEM-1 to MEM-13, R-8 | |
| PR 8: Runner hooks for Memory | The runner's hooks for Memory (deterministic run of retention, internal history, fault injection). Enable and pass all Memory cases. Tests replacing the current `memory-event-store.test.ts` | MEM conformance cases, IP 5 item 1 (Memory) | |
| PR 9: DynamoDB foundation | Creating the three tables (test side), the move to DynamoDB Local (Chapter 6), configuration items (DY-8), layout verification (`layout.json`) | DY-2, DY-3, DY-8, DY-16 to DY-19, P-19, P-40, IP 5 item 2 | |
| PR 10: DynamoDB writes, reads, and failure classification | Writes, reads, D-5, D-6, D-7, verification of `item-shapes.json` | D-4 to D-7, DY-9 to DY-11, W-3 to W-9, R-1 to R-8, P-25 | |
| PR 11: DynamoDB retention and fault injection | Retention processing (delete mode, TTL mode), the runner's SDK middleware and fault injection | D-3, D-9, P-18, P-24, S-2 to S-4, IP 5 item 1 (DynamoDB) | |
| PR 12: Migration | Repoint `index.ts` to `src/next/`. Move `examples` and `packages/tests` to the new API (from LocalStack to DynamoDB Local) | IP 5 item 3 | The old implementation is not yet removed (not published) |
| PR 13: Removing the old implementation | Remove the old API and old implementation (`shard-*`, `default-serializer`, old `dynamodb-*`, old `memory-*`, the whole Spanner set, LocalStack tests and dependencies) and move `src/next/` to `src/` | Removal point | `package-tests` and `examples` pass with the new API |
| PR 14: Documentation | Align the README (English and Japanese), schema documents, and migration guide with the new contract (IP 5 items 5 and 6). The procedure document in Chapter 8 | IP-D8 | |
| Publication | After the owner's approval, publish 5.0.0 manually (implementation plan Chapter 3) | IP 5 | |

- When the Spanner code is removed in PR 13, the `@google-cloud/spanner` peer dependency and devDependencies are removed as well. They are restored when it is shipped again in stage 5.

## 8. Migration Guidance

### 8.1 Target

Guidance for users of the current major (4.x). Following Chapter 7 of the implementation plan (IP-D8), **no migration tool is provided for js's old-layout DynamoDB, and only a procedure document is prepared**. The procedure document is created in PR 14. This time only the outline is written.

### 8.2 Characteristics of the Old Layout

- A payload with embedded metadata (the current `default-serializer.ts` serializes the whole event).
- An aid that relies on the user's `asString()`.
- Millisecond time.
- Keys with logical shards (`pkey`, `skey`).
- Precision and type information that was lost is not filled in by guessing.

### 8.3 Outline of the Procedure for Users

1. Stop the old (4.x) application, or decide on a period during which writes are stopped.
2. Create the three new tables (journal, snapshot, head) and the GSI with new names. Keep the old tables.
3. With the old API (4.x), read the events and snapshots per aggregate.
4. In the user's code, build an `EventEnvelope` (`aggregateId`, `seqNr`, `occurredAt`, `manifest`, `payload`) from each old event. How to assign the `manifest` and the shape of the `payload` (removing the old embedded metadata) are decided by the user.
5. With the new API (5.x), write with `persistEvent` in ascending order of `seqNr`. Write the snapshot with `persistEventAndSnapshot` or together with the last event.
6. Reconcile the count and the last `seqNr` between old and new.
7. Switch to the new version (5.x). After confirmation, the user deletes the old tables.
- The old and new cannot use the same library at the same time (different majors of the same package name), so guidance is given on installing 4.x for reading with the old API and 5.x for the new API in separate processes or under different aliases with `npm:` (behavior to be confirmed at implementation; unverified).

### 8.4 API Migration Table

Rewrite the mapping table in 2.10 for users and include it. Users who used the `version` of `Aggregate` move to `seqNr`. `expectedVersion` becomes unnecessary. `isCreated` becomes unnecessary.

## 9. Points Requiring Decisions

This chapter keeps the points decided by the owner (2026-10-06) and their reasons. Only item 2 is pending. Points decided during the design (change feed, the type of `occurredAt`, the `manifest` of `deserialize`, the location of the runner, `fnv1a64`) were finalized in the body and removed from this chapter.

### Item 1: How Failures Are Returned (Decided)

**Decision**: For all write, read, and creation operations, return failures as a `Result<T, EventStoreError>` value (option A).

| Option | Advantages | Disadvantages |
|:--|:--|:--|
| A: Return `Result` from all operations (adopted) | Failures appear in the type. Classification can be branched exhaustively by `type` (E-1). Consistent with the current writes | Users of the current reads must rewrite from exceptions to `Result` |
| B: Return all through exceptions | Closer to JS convention | Failures do not appear in the type. Users of the current writes must rewrite |
| C: `Result` for writes, exceptions for reads and creation | Minimal rewriting for users | Two systems of discrimination. Weakens "classify and return failures of reads and creation as well" |
| D: `Result` for writes and reads, exceptions for creation | Creation is concise | Creation failures also need classification, giving two systems |

- Reason: failure classification can be discriminated by type (E-1), and the form of the current writes is kept. 5.0.0 is a breaking change, so rewriting reads is acceptable ("Decisions (2026-10-06)" in Chapter 5 of the implementation plan).

### Item 2: How to Split the Entry Point So That Spanner Is an Optional Dependency (Pending)

This can be decided by the time Spanner is shipped again in stage 5, so it is not decided now. Only the options are kept.

| Option | Advantages | Disadvantages |
|:--|:--|:--|
| A: Subpath export (`event-store-adapter-js/spanner`) | Users import Spanner only when they use it. Stays one package | `exports` configuration is required. Users with an old `moduleResolution` have trouble finding the types. May need `typesVersions` as well |
| B: Separate package (`event-store-adapter-js-spanner`) | Dependencies are completely separate | Adds monorepo packages and release machinery |
| C: Keep as is, expose from the main entry point, and make the peer optional | Minimal change | Breaks type checking for users who have not installed Spanner (depends on `skipLibCheck`) |

- Recommendation: A (a provisional view while pending). The first major (5.0.0) does not ship Spanner code, so this has no effect. The core types do not reference Spanner.

### Item 3: Memory and Multiple Threads (MEM-4) (Decided)

**Decision**: The owner added a js note to MEM-4 of the hub's memory.md (2026-10-06). In JavaScript, objects cannot be shared across threads, so a js storage is shared only within a single thread. MEM-4 is satisfied by not exposing intermediate states before commit even when asynchronous calls overlap within the same thread. A storage that can be shared across threads is not created.

| Option | Advantages | Disadvantages |
|:--|:--|:--|
| A: Protect against asynchronous overlap within the same thread (adopted; follows the note) | Simple implementation. Fits ordinary JS use | No sharing across threads |
| B: Share across threads with `SharedArrayBuffer` and `Atomics` | Sharing across threads is possible | Complicated record representation and memory management. The note states that it is not created |

- Reason: the note in the specification defines A. It is satisfied by following the note, not by reinterpreting it as "same thread only".

## 10. Open Questions

Points where it is unclear how to read the specification, and points that appear to conflict with it. The specification is not interpreted arbitrarily to fill them in. Questions resolved by the lead's answers (2026-10-06) and by the specification decisions of 2026-10-06 (P-42 to P-44; P-45 is the procedure for the migration of rs and is not relevant) were moved into the body. The following three remain, to be confirmed at implementation.

1. **Stage at which middleware is injected**: whether `maxAttempts: 1` and `replace-request` / `replace-response` can be realized at the `build` stage may change behavior depending on the SDK version. This is confirmed by a small prototype in the first implementation PR (5.4).
2. **Behavior of DynamoDB Local 3.3.1**: the hub's `tools/spikes/dynamodb-emulators/README.md` contains records confirming `ReturnValuesOnConditionCheckFailure = ALL_OLD`, Streams NEW_IMAGE, strongly consistent `BatchGetItem`, a sparse GSI, and enabling TTL. Expiry deletion and the occurrence of `UnprocessedKeys` are recorded as not investigated.
3. **`Date` at the edges of the range and T-13**: a millisecond `Date` is checked against the nanosecond signed 64-bit range (2.3). Are there values at the edges of the range (about the years 1677 and 2262) in the conformance data (`occurred-at-min`, `occurred-at-max`, `below-min`, `above-max`) whose result changes depending on the direction of millisecond rounding? Confirm by converting the values in the runner (unverified).

Resolved questions:

- Number of precision-marker cases in the conformance data: the count in the lead's review (4 for milliseconds) was wrong, and the count in the actual data (8 for both nanoseconds and milliseconds) is correct (5.1).
- Gradual change of the public API: the proposal to switch `index.ts` all at once in PR 12 does not conflict with Chapter 3 of the implementation plan (lead's answer, 2026-10-06; 7.2 and 7.3).
- Classification of missing required elements (T-2, T-10): treated as a contract violation (common contract T-2, T-10, P-42). `EventEnvelope.create` and `SnapshotEnvelope.create` check at runtime (2.4).
