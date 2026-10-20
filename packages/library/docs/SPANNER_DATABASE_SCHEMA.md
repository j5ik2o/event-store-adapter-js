# Cloud Spanner schema (v5, `event-store-adapter-js/spanner`)

This document describes the tables that `SpannerEventStore.create(...)` from the `event-store-adapter-js/spanner` entry point expects. For usage, see the [current README](../README.md). The v4 (4.x) two-table schema is kept at the end only as the source of a migration; see the [migration guide](MIGRATION_GUIDE.md).

Only the GoogleSQL dialect is supported. All five tables live in the same database. Every table name is derived from one prefix as `<prefix>_<logical name>`: with the prefix `esa` the tables are `esa_journal`, `esa_head`, `esa_snapshot_current`, `esa_snapshot_history` and `esa_config`. The prefix and every derived name must be valid SQL identifiers, and each derived name is at most 128 characters.

`SpannerEventStore.create(...)` never runs DDL. It only verifies the tables and the configuration row, and it does not create anything that is missing. You create the tables and the configuration row yourself with the procedure below. The examples use the prefix `esa`; replace it with your own prefix.

## Tables

<!-- spanner-schema:tables -->
```sql
CREATE TABLE esa_journal (
  hash_prefix BYTES(8) NOT NULL,
  aid STRING(1024) NOT NULL,
  seq_nr INT64 NOT NULL,
  occurred_at_ns INT64 NOT NULL,
  manifest STRING(MAX) NOT NULL,
  payload BYTES(MAX) NOT NULL
) PRIMARY KEY (hash_prefix, aid, seq_nr);

CREATE TABLE esa_head (
  hash_prefix BYTES(8) NOT NULL,
  aid STRING(1024) NOT NULL,
  type_name STRING(1024) NOT NULL,
  seq_nr INT64 NOT NULL,
  event_occurred_at_ns INT64 NOT NULL,
  event_manifest STRING(MAX) NOT NULL,
  event_payload BYTES(MAX) NOT NULL
) PRIMARY KEY (hash_prefix, aid);

CREATE TABLE esa_snapshot_current (
  hash_prefix BYTES(8) NOT NULL,
  aid STRING(1024) NOT NULL,
  seq_nr INT64 NOT NULL,
  manifest STRING(MAX) NOT NULL,
  payload BYTES(MAX) NOT NULL
) PRIMARY KEY (hash_prefix, aid);

CREATE TABLE esa_config (
  singleton INT64 NOT NULL,
  store_id STRING(36) NOT NULL,
  layout_version INT64 NOT NULL,
  keep_snapshot_count INT64,
  retention_mode STRING(8) NOT NULL,
  ttl_grace_days INT64,
  change_feed_enabled BOOL NOT NULL
) PRIMARY KEY (singleton);
```

`esa_snapshot_history` depends on the retention mode. Use one of the two definitions.

Delete mode, which removes old snapshot history rows immediately. There is no row deletion policy:

<!-- spanner-schema:snapshot-history-delete -->
```sql
CREATE TABLE esa_snapshot_history (
  hash_prefix BYTES(8) NOT NULL,
  aid STRING(1024) NOT NULL,
  seq_nr INT64 NOT NULL,
  manifest STRING(MAX) NOT NULL,
  payload BYTES(MAX) NOT NULL,
  expired_at TIMESTAMP
) PRIMARY KEY (hash_prefix, aid, seq_nr);
```

TTL mode, which marks old rows and lets Spanner TTL remove them later. The row deletion policy carries the grace period in days. `7` is only an example, not a default:

<!-- spanner-schema:snapshot-history-ttl -->
```sql
CREATE TABLE esa_snapshot_history (
  hash_prefix BYTES(8) NOT NULL,
  aid STRING(1024) NOT NULL,
  seq_nr INT64 NOT NULL,
  manifest STRING(MAX) NOT NULL,
  payload BYTES(MAX) NOT NULL,
  expired_at TIMESTAMP
) PRIMARY KEY (hash_prefix, aid, seq_nr),
  ROW DELETION POLICY (OLDER_THAN(expired_at, INTERVAL 7 DAY));
```

Columns:

- `hash_prefix`: the FNV-1a 64 hash of `aid`, as 8 bytes in big-endian order. It is not converted to a signed integer and is not reduced by a shard count. Keys are compared as the exact pair `(hash_prefix, aid)`; if two hashes collide, different `aid` values are still different keys.
- `aid`: `typeName-value`. The UTF-8 size is at most 1024 bytes, which the library checks before writing.
- `seq_nr`: 1 to 2^53 - 1.
- `occurred_at_ns` and `event_occurred_at_ns`: signed 64-bit nanoseconds since the Unix epoch, stored as `INT64`, not as `TIMESTAMP`.
- `esa_snapshot_history.expired_at`: the time at which a row was marked for TTL. It is not the event's occurrence time. It stays `NULL` for rows that are not marked, and TTL never removes those.
- `esa_head` holds the latest committed event with its metadata and payload. `esa_snapshot_current` holds the latest snapshot, and its row is absent if no snapshot has been written.

## Configuration row

`esa_config` holds exactly one row, with `singleton = 1`.

- `store_id`: a lowercase UUID string.
- `layout_version`: the `INT64` value `1`.
- `keep_snapshot_count`: `NULL` for no snapshot history. Otherwise a positive integer that must equal `retention.count` of every client.
- `retention_mode`: `delete` or `ttl`.
- `ttl_grace_days`: a positive number of days in TTL mode, otherwise `NULL`.
- `change_feed_enabled`: this version provides no change feed, so record `FALSE`. A row with `TRUE` is rejected as a configuration error.

For delete mode without snapshot history, set `keep_snapshot_count` to `NULL` and `retention_mode` to `'delete'`. TTL mode requires `retention.count`, so `keep_snapshot_count` must be a positive integer there.

Delete mode, keeping the newest 3 history rows per aggregate:

<!-- spanner-schema:config-delete -->
```sql
INSERT INTO esa_config (singleton, store_id, layout_version, keep_snapshot_count, retention_mode, ttl_grace_days, change_feed_enabled)
VALUES (1, GENERATE_UUID(), 1, 3, 'delete', NULL, FALSE);
```

TTL mode, keeping the newest 3 history rows and a grace period of 7 days. The `7` must equal the `INTERVAL 7 DAY` of the row deletion policy and the `graceDays` of the client:

<!-- spanner-schema:config-ttl -->
```sql
INSERT INTO esa_config (singleton, store_id, layout_version, keep_snapshot_count, retention_mode, ttl_grace_days, change_feed_enabled)
VALUES (1, GENERATE_UUID(), 1, 3, 'ttl', 7, FALSE);
```

## Retention modes

| | delete | TTL |
|:--|:--|:--|
| Client setting | `retention: { count }` or `{ count, mode: "delete" }` | `retention: { count, mode: { type: "ttl", graceDays } }` |
| `retention_mode` | `delete` | `ttl` |
| `ttl_grace_days` | `NULL` | `graceDays` |
| Row deletion policy on `esa_snapshot_history` | none | `OLDER_THAN(expired_at, INTERVAL graceDays DAY)` |
| Old history rows | deleted right after the snapshot write | marked once by setting `expired_at`, then removed by Spanner TTL |

In TTL mode, keep three values equal: the `n` of `INTERVAL n DAY`, `ttl_grace_days` and `graceDays`. Marked rows are not counted as retained snapshots and are never marked again. Physical deletion happens later, at Spanner's discretion. Only `esa_snapshot_history` is affected; `esa_journal`, `esa_head` and `esa_snapshot_current` are never deleted.

Retention runs after a snapshot write has committed. A retention failure does not change the committed write; it is reported through `logger` and `onRetentionFailure`.

## Initialization procedure

Run this procedure outside the application, while no client is writing.

1. Stop every writer of the store.
2. Run the DDL above, with your prefix, and wait for it to finish. Use the `esa_snapshot_history` definition for your retention mode.
3. Confirm that each of the five tables is empty:

   ```sql
   SELECT COUNT(*) FROM esa_journal;
   SELECT COUNT(*) FROM esa_head;
   SELECT COUNT(*) FROM esa_snapshot_current;
   SELECT COUNT(*) FROM esa_snapshot_history;
   SELECT COUNT(*) FROM esa_config;
   ```

4. Write the single configuration row with the matching `INSERT` above.
5. Start the writers. `SpannerEventStore.create(...)` verifies the layout.

`create` returns a `configuration-error` when anything it checks is missing or does not match. It checks that the database uses the GoogleSQL dialect; the column names and types and the primary keys of the five tables; the configuration row (`store_id` as a lowercase UUID, `layout_version` 1, `keep_snapshot_count` equal to the client's `retention.count`, `retention_mode`, `ttl_grace_days`, and `change_feed_enabled` as `FALSE`); and the row deletion policy of `esa_snapshot_history`, which must match the grace period in TTL mode and be absent in delete mode. It does not repair anything.

DDL changes while the store is in use, and data changes that bypass the library, are not supported.

## Changing the retention count

Changing `keep_snapshot_count` is a maintenance procedure that you run outside the library, with every client stopped. The library does not provide a tool for it.

TTL mode requires `retention.count`, so in TTL mode the new count must also be a positive integer. Changing a TTL store to no history (`NULL`), and changing `retention_mode`, are not covered by this procedure.

1. Stop every client of the store and confirm that in-flight writes, reads and retention work have finished. Record the old and new settings and your progress somewhere you can resume from.
2. For each `aid` that has history rows, use a SERIALIZABLE read-write transaction to read the rows with `expired_at IS NULL` in descending `seq_nr` order. With a new count of `n`, keep the newest `n`; with no history (`NULL`, delete mode only), every unmarked row is a target. In delete mode, `DELETE` the target rows. In TTL mode, set `expired_at` to `CURRENT_TIMESTAMP()` only on target rows whose `expired_at IS NULL`; rows that are already marked, and their times, stay unchanged. Split large clean-ups into several transactions and select the targets again in each one. Do not touch `esa_journal`, `esa_head` or `esa_snapshot_current`.
3. After every aggregate is processed, update `keep_snapshot_count` in `esa_config`. In TTL mode, the marking must be complete, but you do not wait for the physical deletion. Then restart the clients so that each one verifies the new setting.

If the procedure fails part-way, keep the clients stopped and run it again with the same target recorded in step 1. Rows that were already deleted or marked are not processed again, and their expiry is not postponed. There is no rollback of the whole store. When you increase the count, or set a count where there was none (delete mode only), rows that were deleted, marked or never kept are not restored or created afterwards; the new setting applies from the next snapshot write.

## v4 (4.x) Cloud Spanner schema (migration source)

This section describes the layout written by the v4 Spanner adapter. The current entry point does not read it. To move the data, follow [Spanner 4.x to the v5 Spanner](MIGRATION_GUIDE.md#spanner-4x-to-the-v5-spanner). The v4 adapter used two GoogleSQL tables: `journal` and `snapshot`.

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

### v4 journal

`journal` stores every event. `occurred_at` is copied from `event.occurredAt`.
Events are read by `(shard_id, aggregate_id)` and ordered by `sequence_number ASC`.

### v4 snapshot

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
