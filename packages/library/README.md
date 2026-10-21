# event-store-adapter-js

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/event-store-adapter-js.svg)](https://badge.fury.io/js/event-store-adapter-js)

Event sourcing with Memory, DynamoDB and Spanner. This library follows [common contract v5](https://github.com/j5ik2o/event-store-adapter/blob/main/docs/spec/README.md); its major version 5 matches the contract revision.

[日本語](./README.ja.md)

## Installation

Requires Node.js 24 or later.

```shell
npm install event-store-adapter-js
```

## Usage

Metadata belongs to envelopes; payloads may be any domain type supported by your serializer. Sequence numbers are safe integers, and writes start at 1 and remain contiguous. Aggregate IDs use `typeName-value`; `typeName` cannot contain `-`, and the complete UTF-8 ID is at most 1024 bytes.

```typescript
import {
  AggregateId, EventEnvelope, EventStore, SnapshotEnvelope,
  type EventStoreError, type Result,
} from "event-store-adapter-js";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value;
}

const store = unwrap(EventStore.createMemory<{ added: number }, { total: number }>());
const id = unwrap(AggregateId.of("Order", "1"));
const event = unwrap(EventEnvelope.create({
  aggregateId: id, seqNr: 1, occurredAt: new Date(),
  manifest: "OrderEvent.v1", payload: { added: 2 },
}));
const snapshot = unwrap(SnapshotEnvelope.create({
  seqNr: 1, manifest: "Order.v1", aggregate: { total: 2 },
}));
unwrap(await store.persistEventAndSnapshot(event, snapshot));
unwrap(await store.persistEvent(unwrap(EventEnvelope.create({
  aggregateId: id, seqNr: 2, occurredAt: new Date(),
  payload: { added: 3 },
}))));

const latest = unwrap(await store.getLatestSnapshotById(id));
const saved = latest?.snapshot;
const events = unwrap(await store.getEventsByIdSinceSeqNr(
  id, saved === undefined ? 1 : saved.seqNr + 1,
));
const total = events.reduce((value, next) => value + next.payload.added, saved?.aggregate.total ?? 0);
// total === 5; latest.headSeqNr === 2; saved.seqNr === 1.
```

`getLatestSnapshotById` returns `undefined` when no head exists. When a head exists, it returns `{ headSeqNr, snapshot }`, with an optional snapshot. Start replay at snapshot number + 1, or 1 without a snapshot. The head number describes the latest committed event.

Both factories and all four operations return `Result`. DynamoDB creation is asynchronous. Errors are `contract-violation` (including `rule`), `optimistic-lock-conflict`, `serialization-error`, `configuration-error`, or `storage-error`; the original `cause` is preserved when present.

## DynamoDB

Create the three tables and history GSI described in [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) before opening the store. The library creates or verifies their shared configuration items. Keep the three tables in one Region and write to them only from that Region. Global tables (multi-Region replicas) are not supported.

```typescript
const opened = await EventStore.createDynamoDB({
  client: dynamodbClient,
  tables: { journal: "journal", snapshot: "snapshot", head: "head" },
  snapshotAidIndexName: "snapshot-history",
  retention: { count: 3, mode: { type: "delete" } },
  onRetentionFailure: (failure) => console.error(failure.kind, failure.cause),
});
const store = unwrap(opened);
```

The caller owns the AWS client. Snapshot retention runs after a successful snapshot write; event-only DynamoDB writes send no retention requests. Retention failure preserves the successful write and is reported through the logger and `onRetentionFailure`. For TTL use `mode: { type: "ttl", graceSeconds: 3600 }` and enable the snapshot table's `ttl` attribute.

## Spanner

Spanner lives in a separate entry point, `event-store-adapter-js/spanner`. Install the Spanner SDK yourself; it is an optional peer dependency (`^8.7.1 || ^9.0.0`), and the main entry point `event-store-adapter-js` does not load the Spanner SDK.

```shell
npm install event-store-adapter-js @google-cloud/spanner
```

Create the five tables and the configuration row with the procedure in [SPANNER_DATABASE_SCHEMA.md](docs/SPANNER_DATABASE_SCHEMA.md) before opening the store. `SpannerEventStore.create` never runs DDL; it only verifies the tables and the configuration row.

```typescript
import { SpannerEventStore } from "event-store-adapter-js/spanner";

const opened = await SpannerEventStore.create({
  database: spannerDatabase,
  tablePrefix: "esa",
  retention: { count: 3, mode: "delete" },
  transactionRetryLimit: 5,
  onRetentionFailure: (failure) => console.error(failure.kind, failure.cause),
});
const store = unwrap(opened);
```

`database` is a `Database` of `@google-cloud/spanner` and `tablePrefix` derives the five table names. The caller owns the `Database` and closes it. The result is `Result<EventStore, EventStoreError>`; a missing or mismatched table or configuration is a `configuration-error`. `retention` is `{ count, mode }` with a positive integer `count`; the mode is `"delete"` (the default) or `{ type: "ttl", graceDays }` with a positive integer number of days. `transactionRetryLimit` is the maximum number of re-runs after an ABORTED transaction; the default is 5 and the first attempt is not counted. Snapshot retention runs after a successful snapshot write, and a retention failure is reported through the logger and `onRetentionFailure`.

To move data from the v4 Spanner adapter (the `journal` and `snapshot` tables), use `migrateV4Spanner` from the same entry point; it checks every row first and writes nothing if any row is rejected. See [Spanner 4.x to the v5 Spanner](docs/MIGRATION_GUIDE.md#spanner-4x-to-the-v5-spanner).

This version provides no change feed. Passing `changeFeed` is a `configuration-error`, and the configuration row records `change_feed_enabled` as `FALSE`.

## Serializers and Memory storage

The default `PayloadSerializer.json()` handles JSON values only. A custom synchronous `PayloadSerializer<P>` implements `serialize(payload): Uint8Array` and `deserialize(bytes, manifest): P`. Serialize the payload alone and restore domain classes or brands in `deserialize`. See the [domain serializers](../examples/src/domain/user-account-serializers.ts) in the runnable examples.

The memory storage lives in a single process. It does not persist to files, survive restarts, or share data across processes. Memory creation without a storage uses isolated storage. To share records, pass the same value returned by `MemoryStorage.create()` to multiple factories. Configure retention on that storage:

```typescript
const storage = unwrap(MemoryStorage.create({ retention: { count: 3 } }));
const first = unwrap(EventStore.createMemory({ storage }));
const second = unwrap(EventStore.createMemory({ storage }));
```

Memory supports deletion retention, including cleanup on a later event-only write after a retention failure. It does not support TTL. JavaScript time uses `Date` at millisecond precision; DynamoDB stores event epoch nanoseconds derived from the complete epoch millisecond value. Sub-millisecond precision is outside this API's representation.

## Migration and development

Read the [JavaScript migration guide](docs/MIGRATION_GUIDE.md) before moving existing records into new tables. The old shard, version, converter and serializer APIs are outside this entry point. Spanner is provided by `event-store-adapter-js/spanner`; the main entry point does not load the Spanner SDK. To move data from the v4 Spanner adapter, see the Spanner section of the migration guide.

From the repository root:

```shell
pnpm install
pnpm run build
pnpm run lint
pnpm run test:packages
pnpm run test:examples
pnpm run coverage --runInBand
pnpm run example:memory
pnpm run example:dynamodb
```

DynamoDB tests and examples use DynamoDB Local 3.3.1 through Testcontainers and require Docker. Spanner tests use the Cloud Spanner emulator through Testcontainers and also require Docker. Package tests also pack, install, type-check and execute the library from an independent external project. Conformance results are saved under the library's `coverage/conformance` directory; set `CONFORMANCE_REPORT_DIR` to choose another output directory.

## License

Dual-licensed under MIT and Apache-2.0. See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).

[Common documents](https://github.com/j5ik2o/event-store-adapter)
