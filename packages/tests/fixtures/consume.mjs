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
import rootDefault, * as root from "event-store-adapter-js";
import bigtableDefault, * as bigtable from "event-store-adapter-js/bigtable";
import { BigtableEventStore } from "event-store-adapter-js/bigtable";
import spannerDefault, * as spanner from "event-store-adapter-js/spanner";
import { SpannerEventStore } from "event-store-adapter-js/spanner";
import sqliteDefault, * as sqlite from "event-store-adapter-js/sqlite";
import {
  SqliteBlockingExecution,
  SqliteEventStore,
} from "event-store-adapter-js/sqlite";
import * as released from "released-event-store-adapter-js";
import * as releasedBigtable from "released-event-store-adapter-js/bigtable";
import * as releasedSpanner from "released-event-store-adapter-js/spanner";
import * as releasedSqlite from "released-event-store-adapter-js/sqlite";

const unwrap = (result) => {
  if (result.type === "err") throw result.error;
  return result.value;
};

const require = createRequire(import.meta.url);
const commonJs = require("event-store-adapter-js");
const commonJsSqlite = require("event-store-adapter-js/sqlite");

// 5.2.0 resolved `import` to CommonJS. Its default and names must still import.
for (const [entry, namespace, defaultExport, releasedNamespace] of [
  ["", root, rootDefault, released],
  ["/bigtable", bigtable, bigtableDefault, releasedBigtable],
  ["/spanner", spanner, spannerDefault, releasedSpanner],
  ["/sqlite", sqlite, sqliteDefault, releasedSqlite],
]) {
  const names = Object.keys(namespace);
  for (const name of Object.keys(releasedNamespace))
    assert.ok(names.includes(name), `event-store-adapter-js${entry} lost ${name}`);
  const commonJsExports = require(`event-store-adapter-js${entry}`);
  assert.deepEqual(Object.keys(defaultExport), Object.keys(commonJsExports));
  const shape = (object, name) => {
    const { value, get, set, ...flags } = Object.getOwnPropertyDescriptor(object, name);
    return { ...flags, value: typeof value, get: typeof get, set: typeof set };
  };
  for (const name of [...Object.keys(releasedNamespace.default), "__esModule"]) {
    assert.ok(Object.hasOwn(defaultExport, name), `default lost ${name}`);
    assert.deepEqual(shape(defaultExport, name), shape(releasedNamespace.default, name), name);
    if (name !== "__esModule") assert.equal(defaultExport[name], namespace[name], name);
  }
  assert.equal(namespace["module.exports"], defaultExport);
  assert.equal(namespace.__esModule, true);
  assert.equal(defaultExport.__esModule, true);
  assert.equal(
    (await import(`event-store-adapter-js${entry}`)).default,
    defaultExport,
  );
}

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
