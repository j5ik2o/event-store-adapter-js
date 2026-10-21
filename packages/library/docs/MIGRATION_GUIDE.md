# JavaScript migration to the envelope API

This guide covers applications using the old JavaScript 4.x API with the old two-table DynamoDB layout or the old two-table Spanner layout. The new public API reads the new layouts only: three DynamoDB tables, or the five Spanner tables of the `event-store-adapter-js/spanner` entry point. The DynamoDB procedure comes first; for Spanner, see [Spanner 4.x to the v5 Spanner](#spanner-4x-to-the-v5-spanner). The DynamoDB procedure is a caller-managed export and rewrite procedure, not a migration tool. The Spanner layout has a migration function, `migrateV4Spanner`. Rust migration tools do not handle this JavaScript layout.

## Prepare and export

1. Stop old writes, or arrange a fixed export point and a cutover window. Keep the old application, exact installed package version, domain converters/serializers and tables available for reading.
2. Create new journal, snapshot and head tables under new names, including the history GSI and any required TTL settings, following [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).
3. In a separate process using the installed old 4.x package, use the old API to read all events for each aggregate from sequence number 1, and any snapshots you intend to migrate. Export the domain values and confirmed metadata. Reading from a snapshot's number alone would omit the history needed for a complete rewrite.
4. In caller-owned conversion code, separate envelope metadata from event and aggregate payloads. Map each old aggregate to an explicit valid `AggregateId`: the new `typeName` cannot contain `-`. Decide the payload schema and `manifest`, and provide `PayloadSerializer` implementations if the payload is a domain object rather than a JSON value.
5. Verify the original event order and build a mapping from old event numbers to new contiguous numbers starting at 1. Attach each snapshot to the event whose state it represents and use that event's new number. Keep this mapping in your export records.

Use separate old-reader and new-writer processes, each with its own installed package. Exchange application-defined export data between them. The new library does not provide old API aliases or old-format readers.

## Confirm timestamps before conversion

Inspect the actual old package, serializer, table attributes and exported payload metadata. Do not assume a numeric timestamp's unit or that it contains the full epoch value. Some old JavaScript write paths stored only the UTC millisecond component; a component cannot reconstruct the original instant. Use an independently confirmed timestamp from the export when available. If the source data lacks that information, resolve it as a migration data issue instead of inventing an instant or precision.

The new API requires `Date`, with millisecond precision. Do not invent lost sub-millisecond digits or infer original units from magnitude. Record any confirmed loss of precision in the export.

## Rewrite and verify

Use the new package in the writer process, open the new tables, and write each aggregate in the confirmed order. The following helper consumes data **already separated and validated by the caller**. It assigns the new numbers and writes each event exactly once; an associated snapshot is written with that same event.

```typescript
import {
  EventEnvelope, SnapshotEnvelope,
  type AggregateId, type EventStore, type EventStoreError, type Result,
} from "event-store-adapter-js";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message, { cause: result.error });
  return result.value;
}

// Caller-prepared records for one aggregate, in the confirmed original order.
type Converted = {
  occurredAt: Date;
  manifest: string;
  payload: unknown;
  snapshot?: { manifest: string; aggregate: unknown };
};

async function rewrite(
  target: EventStore, id: AggregateId, records: readonly Converted[],
): Promise<void> {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const seqNr = index + 1;
    const event = unwrap(EventEnvelope.create({
      aggregateId: id, seqNr, occurredAt: record.occurredAt,
      manifest: record.manifest, payload: record.payload,
    }));
    if (record.snapshot === undefined) {
      unwrap(await target.persistEvent(event));
    } else {
      const snapshot = unwrap(SnapshotEnvelope.create({
        seqNr, manifest: record.snapshot.manifest,
        aggregate: record.snapshot.aggregate,
      }));
      unwrap(await target.persistEventAndSnapshot(event, snapshot));
    }
  }
  const events = unwrap(await target.getEventsByIdSinceSeqNr(id, 1));
  const latest = unwrap(await target.getLatestSnapshotById(id));
  if (events.length !== records.length ||
      events.some((event, index) => event.seqNr !== index + 1) ||
      (latest?.headSeqNr ?? 0) !== records.length) {
    throw new Error("rewrite count or final sequence mismatch");
  }
}
```

With default JSON serialization, `records` contains JSON payloads. For custom domain values, configure both serializers when opening the target store.

Compare exported and rewritten event counts, contiguous numbers, final head number, metadata and deserialized payloads. Restore each aggregate from snapshot number + 1, or 1 without a snapshot, and compare domain state. Snapshot history retention may discard older history, so verify current state independently of how many snapshots remain.

After verification, switch the application to the new entry point and new tables. Keep the old export and tables until the caller confirms cleanup.

## Spanner 4.x to the v5 Spanner

This section moves data written by the v4 Spanner adapter (the `journal` and `snapshot` tables, see the [v4 schema](SPANNER_DATABASE_SCHEMA.md#v4-4x-cloud-spanner-schema-migration-source)) into the five v5 tables with `migrateV4Spanner` from `event-store-adapter-js/spanner`. The function reads both v4 tables, checks every row, and writes only if nothing is rejected. Read the conventions of the v4 adapter in commit `a443ef9` (`packages/library/src/internal/spanner-event-store.ts`) when you write the restore functions.

What the v4 adapter wrote:

- `aggregate_id` is the result of `aggregateId.asString()`. Its format was chosen by the application, so the type name and the value cannot be recovered from the string alone. The function never splits it at `-`. `shard_id` was chosen by the shard selector, which the application could replace, so the same `aggregate_id` may exist under more than one `shard_id`.
- `payload` is the output of the event serializer. The default serializer wrote the whole event as JSON: `{ "type": event.typeName, "data": event }`. There is no manifest column.
- `occurred_at` is a `TIMESTAMP` written from `Date.toISOString()`, so it has millisecond precision.
- `sequence_number` is the number carried by the event. v4 did not check that the numbers are contiguous. Its primary key prevents duplicates only within one `shard_id`.
- In `snapshot`, the row with `sequence_number = 0` is the latest snapshot. It has no column that says which event it was taken at. An event-only write advanced `version` without replacing `payload`. Rows with `sequence_number > 0` are retained copies. `version` and the retained copies are not moved to v5.

Steps:

1. Stop every v4 writer. Keep the v4 tables, the exact v4 package version and your converters and serializers available for reading. The function does not change the v4 tables.
2. Create the five v5 tables under a **new prefix** and write the configuration row, following the initialization procedure of [SPANNER_DATABASE_SCHEMA.md](SPANNER_DATABASE_SCHEMA.md). The function never creates tables or the configuration row. It rejects a target that is not initialized, a target that already has rows, and v4 table names that overlap the target tables.
3. Write `restoreEvent`. It receives one v4 journal row (`aggregateId`, `shardId`, `sequenceNumber`, `payload`, `occurredAt`) and returns the type name, the value, the manifest and the v5 payload, or a reason string if the row cannot be restored. Use the v4 serializer and converter that wrote the row. The v4 manifest does not exist, so you decide it to match the new payload shape.

   ```ts
   import { migrateV4Spanner } from "event-store-adapter-js/spanner";

   const restoreEvent = (row) => {
     // v4 default serializer: { type, data } where data is the whole event
     const stored = JSON.parse(new TextDecoder().decode(row.payload));
     const event = v4Converter(stored.data); // your v4 converter
     if (event.aggregateId.asString() !== row.aggregateId) {
       return { type: "err", error: "aggregate_id does not match the event" };
     }
     return {
       type: "ok",
       value: {
         typeName: event.aggregateId.typeName,
         value: event.aggregateId.value,
         manifest: stored.type,
         payload: toDomainValue(event), // only the domain value, without metadata
       },
     };
   };
   ```

4. Prepare `typeNameMapping` (a `Map`) if a v4 type name contains `-`, which v5 does not allow. The function replaces only type names that contain `-`, using the map. It rejects a type name that has no entry, a replacement that still contains `-`, a new `aid` over 1024 bytes in UTF-8, and two different `aggregate_id` values that become the same new `aid`.
5. Optionally write `restoreSnapshot`. It is called once for each aggregate that has v4 snapshot rows, with `{ aggregateId, maxSeqNr, latest, retained }`, and returns a v5 `SnapshotEnvelope` or `undefined` to move no snapshot. The latest v4 row (`sequence_number = 0`) records no event number, and after an event-only write its `payload` is older than the latest event. Decide the number only from information that you have confirmed. One example is a retained copy whose `payload` bytes equal those of the latest row, when exactly one copy matches. The number must be at least 1 and at most `maxSeqNr`. Without this function, or when it returns `undefined`, only the events of that aggregate are moved.
6. Run the function:

   ```ts
   const result = await migrateV4Spanner({
     database,
     v4Tables: { journal: "journal", snapshot: "snapshot" },
     target: { tablePrefix: "esa_v5" }, // same input as SpannerEventStore.create, without database
     typeNameMapping: new Map([["order-item", "OrderItem"]]),
     restoreEvent,
     restoreSnapshot,
   });
   ```

7. Read the result. It is a `Result`; on success the value is a report:
   - `aggregates`, `events` and `snapshots` are the numbers moved.
   - `eventsOnlyAggregates` lists the v4 `aggregate_id` values moved without a snapshot. Decide whether that is acceptable before switching.

   On failure, `error.type` tells what happened:
   - `rejected`: the check rejected the data and **nothing was written**. `rejections` lists `table`, `aggregateId`, `shardId`, `sequenceNumber` and `reason` for every rejected item: a missing or duplicate `sequence_number`, rows of one `aggregate_id` that restore to different type names or values, a timestamp finer than a millisecond, a row refused by `restoreEvent`, an unusable type name or `aid`, a snapshot number above the maximum or without an event, a snapshot row whose aggregate has no journal rows, and a target that is not ready. Fix the cause at its source and run again. Do not renumber events to hide a gap or a duplicate.
   - `error`: a failed configuration check, a failure reading the source tables, or a storage failure on the target, with the counts written so far in `progress`.
   - `verification-failed`: the data was written but reading it back differs from the plan; `mismatches` lists each aggregate and reason.

   The function reads the v4 tables and the target state in one strong read-only transaction, so the check and the write use the same data. After writing, it reads every aggregate back through the public API and compares the event count, that the numbers are contiguous from 1, that `headSeqNr` equals the maximum number, and the snapshot number.

   The function reads both v4 tables completely into memory in one strong read and copies the payloads, so it needs roughly twice the total payload size of the v4 tables, or more, in memory.
8. This version provides no change feed. If a downstream process or read model depended on the v4 data, decide how to rebuild it before switching over.
9. Switch the application to the new prefix only after the function returned a successful report. Keep the v4 tables until you have confirmed that they can be cleaned up.

Partial migration and recovery: the function writes each event with its own transaction through the public API, one aggregate at a time in ascending order of the new `aid`. If a storage failure (`error`) or a failed read-back (`verification-failed`) happens after writing has started, the target keeps the rows already written; the function does not roll them back. The check runs before any write, so a `rejected` result leaves the target untouched. To recover from a partial migration, do not reuse the target as it is, because it now has rows and will be rejected. Drop and recreate the five tables, or create them under another new prefix, initialize them again, and run the function again with the same input. The v4 tables are unchanged, so you can repeat this.

## API changes

| Old API / setting | New contract |
| --- | --- |
| `EventStore<Id, Aggregate, Event>` | `EventStore<EventPayload, SnapshotPayload>` |
| Events and aggregates with persistence metadata | `EventEnvelope` and `SnapshotEnvelope`, payload separate |
| `persistEvent(event, expectedVersion)` | `persistEvent(envelope)`, contiguous `seqNr` controls locking |
| `getEventsByIdSinceSequenceNumber` | `getEventsByIdSinceSeqNr`, Result of envelopes |
| Direct latest aggregate | Result of `{ headSeqNr, snapshot? }`, or `undefined` without a head |
| Synchronous direct DynamoDB factory | `await EventStore.createDynamoDB(input)`, Result |
| Direct Memory factory | `EventStore.createMemory(input?)`, Result |
| `eventConverter`, `snapshotConverter`, old serializers | `eventSerializer`, `snapshotSerializer`: payload bytes and manifest |
| `keepSnapshotCount`, `deleteTtlMillis` | `retention: { count, mode }`; TTL `graceSeconds` is seconds |
| Shard settings and journal GSI | Three-table layout, direct journal reads |
| `isCreated`, aggregate `version` | Event number and conditional head transition |
| Spanner (`EventStore.createSpanner`) | `await SpannerEventStore.create(input)` from `event-store-adapter-js/spanner`, Result; create the tables as described in [SPANNER_DATABASE_SCHEMA.md](SPANNER_DATABASE_SCHEMA.md) |
