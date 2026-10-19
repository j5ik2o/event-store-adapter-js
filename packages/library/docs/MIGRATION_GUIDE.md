# JavaScript migration to the envelope API

This guide covers applications using the old JavaScript 4.x API with the old two-table DynamoDB layout or the old two-table Spanner layout. The new public API reads the new layouts only: three DynamoDB tables, or the five Spanner tables of the `event-store-adapter-js/spanner` entry point. The DynamoDB procedure comes first; for Spanner, see [Spanner 4.x to the v5 Spanner](#spanner-4x-to-the-v5-spanner). This is a caller-managed export and rewrite procedure, not a migration tool; Rust migration tools do not handle this JavaScript layout.

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

This section moves data written by the v4 Spanner adapter (the `journal` and `snapshot` tables, see the [v4 schema](SPANNER_DATABASE_SCHEMA.md#v4-4x-cloud-spanner-schema-migration-source)) into the five v5 tables. It is a caller-managed procedure, not a migration tool. Read the conventions of the v4 adapter in commit `a443ef9` (`packages/library/src/internal/spanner-event-store.ts`) where this section says to confirm something. Anything that the v4 contract does not determine is for you to confirm; do not guess it.

What the v4 adapter wrote:

- `aggregate_id` is the result of `aggregateId.asString()`. Its format was chosen by the application, so the type name and the value cannot be recovered from the string alone. `shard_id` was chosen by the shard selector, which the application could replace, so the same `aggregate_id` may exist under more than one `shard_id`.
- `payload` is the output of the event serializer. The default serializer wrote the whole event as JSON: `{ "type": event.typeName, "data": event }`. There is no manifest column.
- `occurred_at` is a `TIMESTAMP` written from `Date.toISOString()`, so it has millisecond precision.
- `sequence_number` is the number carried by the event. v4 did not check that the numbers are contiguous. Its primary key prevents duplicates only within one `shard_id`.
- In `snapshot`, the row with `sequence_number = 0` is the latest snapshot. It has no column that says which event it was taken at. An event-only write advanced `version` without replacing `payload`. Rows with `sequence_number > 0` are retained copies, written with the number of the event at that time.

Steps:

1. Stop every v4 writer. Keep the v4 tables, the exact v4 package version and your converters and serializers available for reading.
2. Create the five v5 tables under a **new prefix**, following the initialization procedure of [SPANNER_DATABASE_SCHEMA.md](SPANNER_DATABASE_SCHEMA.md): run the DDL, confirm that the tables are empty, then write the configuration row.
3. Check the old tables before moving anything. These queries are examples. Run each one over the whole table, not per shard.

   Missing numbers and duplicates. An aggregate is sound only if its numbers run from 1 to the maximum with no gap and no duplicate, counting all shards together. This query returns the aggregates that are not:

   ```sql
   SELECT aggregate_id,
          COUNT(*) AS row_count,
          COUNT(DISTINCT sequence_number) AS distinct_numbers,
          MIN(sequence_number) AS min_number,
          MAX(sequence_number) AS max_number
   FROM journal
   GROUP BY aggregate_id
   HAVING MIN(sequence_number) <> 1
       OR COUNT(*) <> COUNT(DISTINCT sequence_number)
       OR COUNT(*) <> MAX(sequence_number);
   ```

   Timestamps finer than a millisecond. The v4 adapter cannot have written these, so such a row is a data problem; stop and find out where it came from:

   ```sql
   SELECT aggregate_id, sequence_number
   FROM journal
   WHERE MOD(UNIX_MICROS(occurred_at), 1000) <> 0;
   ```

   Snapshot numbers beyond the last event. A snapshot must not have a number above the aggregate's maximum event number:

   ```sql
   SELECT s.aggregate_id, s.sequence_number
   FROM snapshot AS s
   LEFT JOIN (
     SELECT aggregate_id, MAX(sequence_number) AS max_number
     FROM journal
     GROUP BY aggregate_id
   ) AS j ON j.aggregate_id = s.aggregate_id
   WHERE j.max_number IS NULL OR s.sequence_number > j.max_number;
   ```

   Do not migrate an aggregate that any check reports. Do not renumber events to hide a gap or a duplicate; v5 requires numbers to start at 1 and stay contiguous, so such an aggregate must be resolved at its source.

4. Restore the type name and the value from the old data, not from the key string. Read each event with the v4 serializer and converter that wrote it, and take `event.aggregateId.typeName` and `event.aggregateId.value`. Check that `event.aggregateId.asString()` equals the stored `aggregate_id`. Do not split `aggregate_id` at a `-` to guess them. If you used a custom way to derive the key, or the data lacks the information needed, do not migrate that aggregate.
   - A v4 type name may contain `-`, which v5 does not allow. Replace it through a mapping table that you provide, and apply it to every aggregate of that type.
   - Build each new ID with `AggregateId.of`. An `aid` whose UTF-8 size exceeds 1024 bytes is returned as a `contract-violation` error; resolve it before writing.
   - Check that two different old keys never produce the same new `aid`. After the type-name mapping, collisions are possible.
5. Convert each event. The v4 payload holds the whole event (`{ type, data }` with the default serializer), with its metadata inside. Take out only the domain value to use as the v5 payload. v4 stored no manifest, so you decide it to match the new payload shape. With the default serializer, `type` held `event.typeName`.
6. Convert the time. The v4 `TIMESTAMP` has millisecond precision. Pass it to v5 as a `Date`; v5 stores it as nanoseconds (`INT64`) computed from the epoch milliseconds, with zero below the millisecond. The precision that v4 never stored is not recovered, and the result is not evidence that the original time had nanosecond precision.
7. Decide the snapshot number. The latest v4 row (`sequence_number = 0`) records no event number, and after an event-only write its `payload` is older than the latest event. Decide the number only from information that you have confirmed. One example is a retained copy (`sequence_number > 0`) whose `payload` bytes are equal to those of the latest row, when exactly one copy matches. Another is a number that your domain guarantees. Check that the number is at most the maximum event number. If you cannot decide it, do not migrate the snapshot: migrate the events only. Do not migrate `version`. The retained copies are not moved to `esa_snapshot_history`; v5 builds history by its own rule on each later snapshot write.
8. Write with the v5 API. Open the store with `SpannerEventStore.create` and use the `rewrite` helper of the [DynamoDB procedure](#rewrite-and-verify) in the confirmed order, one aggregate at a time. Step 3 confirmed that the old numbers start at 1 and are contiguous, so the helper's `index + 1` equals the old number; nothing is renumbered. An aggregate's snapshot belongs to the record whose number you decided in step 7. The last write of an aggregate creates the v5 head with the maximum number and that event's envelope. Pass a serializer pair to `SpannerEventStore.create` if the payload is a domain object.
9. Read the data back and compare. For each aggregate, confirm the event count and that the numbers are contiguous from 1, that `headSeqNr` equals the maximum number, the snapshot number, manifest, payload, occurrence time and restored domain state. Restore from the snapshot number + 1, or 1 without a snapshot.
10. This version provides no change feed. If a downstream process or read model depended on the v4 data, decide how to rebuild it before switching over.
11. Switch the application to the new prefix. Keep the v4 tables until you have confirmed that they can be cleaned up.

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
