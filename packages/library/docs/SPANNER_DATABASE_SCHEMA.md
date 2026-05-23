## Cloud Spanner schema used by EventStore

The Spanner adapter uses two GoogleSQL tables: `journal` and `snapshot`.
The caller owns the `Database` lifecycle and passes it to `EventStore.ofSpanner(...)`.

```sql
CREATE TABLE journal (
  shard_id INT64 NOT NULL,
  aggregate_id STRING(MAX) NOT NULL,
  sequence_number INT64 NOT NULL,
  payload BYTES(MAX) NOT NULL,
  occurred_at TIMESTAMP NOT NULL
) PRIMARY KEY (shard_id, aggregate_id, sequence_number);

CREATE TABLE snapshot (
  shard_id INT64 NOT NULL,
  aggregate_id STRING(MAX) NOT NULL,
  sequence_number INT64 NOT NULL,
  version INT64 NOT NULL,
  payload BYTES(MAX) NOT NULL,
  updated_at TIMESTAMP NOT NULL
) PRIMARY KEY (shard_id, aggregate_id, sequence_number);
```

### Journal

`journal` stores every event. `occurred_at` is copied from `event.occurredAt`.
Events are read by `(shard_id, aggregate_id)` and ordered by `sequence_number ASC`.

### Snapshot

`snapshot` stores the latest snapshot and optional retained snapshot copies.

| `sequence_number` | Meaning |
|:--|:--|
| `0` | Latest snapshot row. Reads use this row. |
| `> 0` | Retained snapshot copy for `keepSnapshotCount`. |

`updated_at` is copied from the corresponding `event.occurredAt`.
Event-only updates advance the latest snapshot `version` without replacing `payload`.

Retention is hard-delete only. When `keepSnapshotCount` is set, rows with
`sequence_number > 0` are ordered by newest `sequence_number` and older rows are
deleted. The latest snapshot row with `sequence_number = 0` is never counted or
deleted by retention.

### Change Streams

Change Streams are outside the initial adapter scope. If downstream integration
is added later, monitor `journal`, not `snapshot`, so every domain event is
observed exactly once by aggregate sequence.
