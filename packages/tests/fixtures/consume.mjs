import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AggregateId,
  EventEnvelope,
  EventStore,
  MemoryStorage,
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

const require = createRequire(import.meta.url);
const commonJs = require("event-store-adapter-js");
const commonJsSqlite = require("event-store-adapter-js/sqlite");

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
const esmStorage = unwrap(MemoryStorage.create());
const commonJsStorage = unwrap(commonJs.MemoryStorage.create());
assert.equal(commonJs.EventStore.createMemory({ storage: esmStorage }).type, "ok");
assert.equal(EventStore.createMemory({ storage: commonJsStorage }).type, "ok");
assert.equal(typeof SpannerEventStore.create, "function");
assert.equal(typeof SqliteEventStore.create, "function");
assert.equal(typeof SqliteBlockingExecution.singleWorker, "function");
assert.equal(typeof BigtableEventStore.create, "function");

const directory = mkdtempSync(join(tmpdir(), "eswa-esm-sqlite-"));
try {
  const esmExecution = unwrap(SqliteBlockingExecution.singleWorker(1));
  const commonJsPath = join(directory, "common-js.sqlite3");
  unwrap(await commonJsSqlite.SqliteEventStore.initialize({ path: commonJsPath }));
  const commonJsStore = unwrap(
    await commonJsSqlite.SqliteEventStore.createOffloaded(
      { path: commonJsPath },
      esmExecution,
    ),
  );
  unwrap(commonJsStore.close());
  esmExecution.close();
  await esmExecution.drained();

  const commonJsExecution = unwrap(
    commonJsSqlite.SqliteBlockingExecution.singleWorker(1),
  );
  const esmPath = join(directory, "esm.sqlite3");
  unwrap(await SqliteEventStore.initialize({ path: esmPath }));
  const esmStore = unwrap(
    await SqliteEventStore.createOffloaded({ path: esmPath }, commonJsExecution),
  );
  unwrap(esmStore.close());
  commonJsExecution.close();
  await commonJsExecution.drained();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
