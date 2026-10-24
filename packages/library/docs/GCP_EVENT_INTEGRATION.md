# Options for event-driven integration on GCP

This document is a design memo that organizes the options for achieving downstream processing similar to `DynamoDB Streams + Lambda` on GCP.
The reference date is `2026-03-12`. Spanner is provided by the `event-store-adapter-js/spanner` entry point. This version does not provide change feeds (Change Streams). There is no Firestore adapter. For the available API, see the [current README](../README.md).

## Conclusion

- `Cloud Pub/Sub + Cloud Functions` is not a direct replacement for `DynamoDB Streams + Lambda`
- If you want to start from database changes, use `Firestore trigger` or `Spanner Change Streams`
- The candidates that fit this library's Event Store well are `Firestore` and `Spanner`
- `Bigtable` is not realistic

## Correspondence

| AWS | Closest GCP configuration | Notes |
|:--|:--|:--|
| DynamoDB Streams + Lambda | Firestore trigger + Cloud Functions | Light to implement, but the database product differs considerably from DynamoDB |
| DynamoDB Streams + Lambda | Spanner Change Streams + Dataflow + Cloud Run functions / Cloud Functions | The closest configuration that starts from a change stream |
| Asynchronous delivery such as SNS / SQS / EventBridge | Cloud Pub/Sub | `Pub/Sub` itself is not a database change stream |

## Comparison

| Candidate | Detects database changes automatically | Atomic event storage and snapshot update | Ease of downstream integration | Fit with the Event Store | Recommendation |
|:--|:--|:--|:--|:--|:--|
| Firestore + Cloud Functions | Possible | Possible | High | High | High |
| Spanner + Change Streams | Possible | Possible | High | High | High |
| Firestore + Pub/Sub + Cloud Functions | Possible with conditions | Possible | High | High | Medium |
| Bigtable + Pub/Sub + Cloud Functions | Not directly | Weak | Medium | Low | Low |
| Pub/Sub alone | Not possible | Depends on the database | High | Low | Depends on the use |

## Positioning of each option

### Firestore

- A document update can trigger `Cloud Functions`
- Transactions can update multiple documents atomically
- If only the creation of a `journal` document is a trigger target, double invocation caused by `snapshot` updates is easy to avoid

Recommended pattern:

| Purpose | Recommendation |
|:--|:--|
| Event storage | `aggregates/{aggregateId}/journal/{sequenceNumber}` |
| Latest snapshot | `aggregates/{aggregateId}/snapshot/latest` |
| Downstream trigger | `onCreate` under `journal` |

Good fit when:

- You want to keep the amount of implementation small
- You want to lean toward serverless
- You want to connect downstream processing with `Cloud Functions` in a straightforward way

### Spanner

- A `read-write transaction` expresses the simultaneous update of events and snapshots naturally
- `Change Streams` can extract database changes as a stream
- It feels the closest to `DynamoDB Streams` in operation

Recommended pattern:

| Purpose | Recommendation |
|:--|:--|
| Event storage | `journal` table |
| Latest snapshot | `snapshot` table |
| Downstream trigger | `Change Streams -> Dataflow -> Pub/Sub or Cloud Run functions` |

The table above is a design candidate. For the table layout of the current version of the library, see [SPANNER_DATABASE_SCHEMA.md](SPANNER_DATABASE_SCHEMA.md). A configuration that uses Change Streams is not provided in this version. The library treats a setting that asks for a change feed as a configuration error.

Good fit when:

- You want a configuration close to `DynamoDB Streams + Lambda`
- You want clear transactional consistency
- You value future data volume and operational control

### Cloud Pub/Sub

- `Pub/Sub` is a message delivery platform
- It is not a feature that detects database changes automatically
- Therefore, it cannot stand alone in place of `DynamoDB Streams`

Where to use it:

| Usage | Suitability |
|:--|:--|
| Direct detection of database changes | Low |
| Downstream bus for Change Streams / triggers | High |
| Loosely coupled integration between services | High |

## Why Bigtable is not realistic

`Bigtable` does not fit well with the write conditions of the Event Store that this library assumes.

| Aspect | Bigtable constraint | Impact on the Event Store |
|:--|:--|:--|
| Transactions | Basically single-row atomicity | Simultaneous update of `journal` and `snapshot` cannot be handled naturally |
| Optimistic locking | Harder to express than in general RDBs / Firestore / Spanner | The design of `version`-conditioned updates becomes unnatural |
| Change stream | Not a straightforward integration equivalent to `DynamoDB Streams` | The downstream configuration becomes complex |
| Queries | Not straightforward for the retrieval patterns of an Event Store | Both implementation and operation tend to become heavy |

In short, `Bigtable` is excellent as a high-throughput wide-column store, but it is not a platform that satisfies, in balance, what this library needs:

- Event storage
- Latest snapshot update
- Optimistic locking
- Change notification to downstream

## Recommended architecture

### When you need to implement quickly

| Item | Recommendation |
|:--|:--|
| Store | Firestore |
| Downstream processing | Firestore trigger + Cloud Functions |
| Reason | Little implementation, and easy to lean toward a serverless configuration |

### When you prioritize a configuration close to DynamoDB Streams

| Item | Recommendation |
|:--|:--|
| Store | Spanner |
| Downstream processing | Change Streams + Dataflow + Pub/Sub / Cloud Run functions |
| Reason | The closest configuration that starts from a database change stream |

## Design notes

| Topic | Note |
|:--|:--|
| Duplicate execution | Both `Cloud Functions` and `Pub/Sub` assume redelivery and re-execution, so make processing idempotent |
| What to watch | Start from `journal`, not `snapshot` |
| Ordering | Decide how downstream guarantees ordering per aggregate |
| Re-execution | Let downstream deduplicate by `event.id` or `aggregateId + sequenceNumber` |

## Implications for this library

When considering GCP support, the candidates were the following two. Spanner is provided, and Firestore is a design candidate.

| Candidate | Decision |
|:--|:--|
| Firestore adapter | A candidate if implementation effort is the priority. Not provided |
| Spanner adapter | A candidate if a configuration close to `DynamoDB Streams` is the priority. Provided by `SpannerEventStore.create(...)` from `event-store-adapter-js/spanner`. Change feeds are not provided in this version |

An adapter for `Bigtable` is not recommended, at least as the first GCP support.

## References

- Firestore triggers: https://cloud.google.com/functions/docs/calling/cloud-firestore
- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Cloud Functions retries: https://docs.cloud.google.com/functions/docs/bestpractices/retries
- Cloud Pub/Sub overview: https://docs.cloud.google.com/pubsub/docs/pubsub_overview
- Pub/Sub exactly-once delivery: https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery
- Spanner Change Streams: https://docs.cloud.google.com/spanner/docs/change-streams
- Spanner emulator: https://cloud.google.com/spanner/docs/emulator
- Bigtable writes and atomicity: https://cloud.google.com/bigtable/docs/writes
