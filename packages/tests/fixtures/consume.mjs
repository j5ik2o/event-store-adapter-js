import assert from "node:assert/strict";
import {
  AggregateId,
  EventEnvelope,
  EventStore,
  SnapshotEnvelope,
} from "event-store-adapter-js";
import { BigtableEventStore } from "event-store-adapter-js/bigtable";
import { SpannerEventStore } from "event-store-adapter-js/spanner";
import {
  SqliteBlockingExecution,
  SqliteEventStore,
} from "event-store-adapter-js/sqlite";

const unwrap = (result) => {
  if (result.type === "err") throw result.error;
  return result.value;
};

const id = unwrap(AggregateId.of("Amount", "1"));
const event = unwrap(
  EventEnvelope.create({
    aggregateId: id,
    seqNr: 1,
    occurredAt: new Date(123),
    payload: { amount: 5 },
  }),
);
const snapshot = unwrap(
  SnapshotEnvelope.create({ seqNr: 1, aggregate: { amount: 5 } }),
);
const store = unwrap(EventStore.createMemory());
unwrap(await store.persistEventAndSnapshot(event, snapshot));
assert.equal(unwrap(await store.getLatestSnapshotById(id)).headSeqNr, 1);
assert.equal(typeof SpannerEventStore.create, "function");
assert.equal(typeof SqliteEventStore.create, "function");
assert.equal(typeof SqliteBlockingExecution.singleWorker, "function");
assert.equal(typeof BigtableEventStore.create, "function");
