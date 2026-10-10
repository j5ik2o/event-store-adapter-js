# JavaScript migration to the envelope API

This guide covers applications using the old JavaScript 4.x API and the old two-table DynamoDB layout. The new public API reads the new three-table layout only. This is a caller-managed export and rewrite procedure, not a migration tool; Rust migration tools do not handle this JavaScript layout.

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

After verification, switch the application to the new entry point and new tables. Keep the old export and tables until the caller confirms cleanup. This change does not publish a release, alter a version number or create a tag.

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
| Spanner | Outside this entry point |
