# DynamoDB schema

Use three distinct tables in one region. The caller creates them; `EventStore.createDynamoDB` verifies shared configuration records. Table names and the history index name come from its input.

| Table | Partition key | Sort key | Index / Streams |
| --- | --- | --- | --- |
| journal | `aid` S | `seq_nr` N | No GSI or Streams |
| snapshot | `aid` S | `skey` N | Configured history GSI: `aid` S + `active_history_seq_nr` N, KEYS_ONLY |
| head | `aid` S | None | Streams enabled, NEW_IMAGE |

TTL is enabled on snapshot's `ttl` attribute only when using TTL retention. Journal and head have no TTL.

## Configuration records

Each table has `aid = "__config__"`; journal adds `seq_nr = 0`, snapshot adds `skey = 0`. Every configuration item contains `store_id` S and `layout_version` N (`1`). The same nonempty store ID is required in all three records. All absent records are created in one conditional transaction. Partial, mismatched or unsupported configurations fail creation. Configuration records are separate from aggregate records.

## Journal records

| Attribute | Type | Meaning |
| --- | --- | --- |
| aid | S | `typeName-value` |
| seq_nr | N | Contiguous event number, starting at 1 |
| occurred_at | N | Complete epoch nanoseconds, derived from JavaScript epoch milliseconds × 1,000,000 |
| manifest | S | Serializer schema identifier; empty string by default |
| payload | B | Serialized domain event payload only |

Reads query the journal table directly with strong consistency and an inclusive `seq_nr >= start` condition, follow every LastEvaluatedKey and return ascending events.

## Head records

A head item has `aid` S, `type_name` S, `seq_nr` N and `events` L. The list contains exactly one M for the committed event, with `seq_nr` N, `occurred_at` N, `manifest` S and `payload` B. Head Streams provide NEW_IMAGE records; this API has no change-feed operation.

The first event conditionally creates the head. Later events require the previous head number to equal `seqNr - 1`. The head transition and journal write commit atomically; sequence numbers replace the old version-based lock.

## Current and history snapshots

Current snapshots use `skey = 0`. Their exact attributes are `aid` S, `skey` N, `seq_nr` N, `last_updated_at` N, `manifest` S and `payload` B. The actual snapshot number is `seq_nr`, not its sort key. `last_updated_at` is the writing event's complete epoch milliseconds. Neither TTL nor history marker belongs to the current snapshot.

With retention configured, the same transaction also creates history with `skey = seq_nr` and `active_history_seq_nr = seq_nr`. Without retention, no history item is created. Event-only writes leave the current snapshot unchanged and perform no retention requests.

Retention keeps the newest configured number of active history snapshots; the current snapshot is separate. Delete mode removes older history. TTL mode atomically adds `ttl` N (mark time in epoch seconds + `graceSeconds`) and removes `active_history_seq_nr`. Already marked records keep their original expiry, and the sparse GSI excludes them. Snapshot payload `payload` contains only the domain aggregate.

Each physical item, including head and snapshots, must fit 409600 bytes. The transaction includes journal, head and any supplied current/history snapshots; an oversized item fails before sending the commit.

## Restoration and migration

Latest snapshot reads strongly read head and current snapshot through BatchGetItem. These reads are not an atomic transaction; the result includes `headSeqNr` and the independently read snapshot. Start replay at `snapshot.seqNr + 1`, or 1 when no snapshot is present.

Existing two-table shard layouts require a rewrite into new tables. Follow the [migration guide](MIGRATION_GUIDE.md); the new reader does not convert old records.
