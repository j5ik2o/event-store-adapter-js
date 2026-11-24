import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as esmRoot from "event-store-adapter-js";
import * as esmSpanner from "event-store-adapter-js/spanner";

// The ESM entry bundles the RetryInfo decoder; CommonJS loads it from protobufjs.
// Both read the same binary google.rpc.retryinfo-bin metadata.
const require = createRequire(import.meta.url);
const entries = [
  ["esm", esmRoot, esmSpanner],
  ["cjs", require("event-store-adapter-js"), require("event-store-adapter-js/spanner")],
];

const varint = (value) => {
  const bytes = [];
  let rest = BigInt(value);
  do {
    const low = Number(rest & BigInt(0x7f));
    rest >>= BigInt(7);
    bytes.push(rest === BigInt(0) ? low : low | 0x80);
  } while (rest !== BigInt(0));
  return bytes;
};
const field = (number, payload) => [...varint(number << 3), ...payload];
const lengthDelimited = (number, bytes) => [...varint((number << 3) | 2), ...varint(bytes.length), ...bytes];
const retryInfo = ({ seconds, nanos }) =>
  Uint8Array.from(
    lengthDelimited(1, [
      ...(seconds === undefined ? [] : field(1, varint(seconds))),
      ...(nanos === undefined ? [] : field(2, varint(nanos))),
    ]),
  );
const aborted = (entries) =>
  Object.assign(new Error("aborted"), {
    code: 10,
    metadata: { get: (key) => (key === "google.rpc.retryinfo-bin" ? entries : []) },
  });

const prefix = "esa";
const key = [["hash_prefix", "BYTES(8)"], ["aid", "STRING(1024)"]];
const tables = {
  journal: [...key, ["seq_nr", "INT64"], ["occurred_at_ns", "INT64"], ["manifest", "STRING(MAX)"], ["payload", "BYTES(MAX)"]],
  head: [...key, ["type_name", "STRING(1024)"], ["seq_nr", "INT64"], ["event_occurred_at_ns", "INT64"], ["event_manifest", "STRING(MAX)"], ["event_payload", "BYTES(MAX)"]],
  snapshot_current: [...key, ["seq_nr", "INT64"], ["manifest", "STRING(MAX)"], ["payload", "BYTES(MAX)"]],
  snapshot_history: [...key, ["seq_nr", "INT64"], ["manifest", "STRING(MAX)"], ["payload", "BYTES(MAX)"], ["expired_at", "TIMESTAMP"]],
  config: [["singleton", "INT64"], ["store_id", "STRING(36)"], ["layout_version", "INT64"], ["keep_snapshot_count", "INT64"], ["retention_mode", "STRING(8)"], ["ttl_grace_days", "INT64"], ["change_feed_enabled", "BOOL"]],
};
const primaryKeys = {
  journal: ["hash_prefix", "aid", "seq_nr"],
  head: ["hash_prefix", "aid"],
  snapshot_current: ["hash_prefix", "aid"],
  snapshot_history: ["hash_prefix", "aid", "seq_nr"],
  config: ["singleton"],
};
const configurationRows = (sql) => {
  if (sql.includes("INFORMATION_SCHEMA.COLUMNS"))
    return Object.entries(tables).flatMap(([table, columns]) =>
      columns.map(([name, type]) => ({ TABLE_NAME: `${prefix}_${table}`, COLUMN_NAME: name, SPANNER_TYPE: type })),
    );
  if (sql.includes("INFORMATION_SCHEMA.INDEX_COLUMNS"))
    return Object.entries(primaryKeys).flatMap(([table, names]) =>
      names.map((name) => ({ TABLE_NAME: `${prefix}_${table}`, COLUMN_NAME: name })),
    );
  if (sql.includes("INFORMATION_SCHEMA.TABLES")) return [];
  if (sql.includes(`${prefix}_config`))
    return [{
      store_id: "00000000-0000-4000-8000-000000000000",
      layout_version: { value: "1" },
      keep_snapshot_count: null,
      retention_mode: "delete",
      ttl_grace_days: null,
      change_feed_enabled: false,
    }];
  throw new Error(`unexpected query ${sql}`);
};

// Every transaction attempt fails: first with ABORTED and the hint, then plainly.
const persistOnce = async ([, root, spanner], cause) => {
  let attempts = 0;
  const database = {
    getDatabaseDialect: async () => "GOOGLE_STANDARD_SQL",
    getSnapshot: async () => [{ run: async ({ sql }) => [configurationRows(sql)], end() {} }],
    getTransaction: async () => {
      attempts += 1;
      const failure = attempts === 1 ? cause : new Error("second attempt");
      return [{
        run: async () => { throw failure; },
        commit: async () => {},
        rollback: async () => {},
        end() {},
      }];
    },
  };
  const created = await spanner.SpannerEventStore.create({ database, tablePrefix: prefix });
  assert.equal(created.type, "ok", JSON.stringify(created.error));
  const id = root.AggregateId.of("Amount", "1").value;
  const event = root.EventEnvelope.create({ aggregateId: id, seqNr: 1, occurredAt: new Date(123), payload: { amount: 5 } }).value;
  const started = performance.now();
  const result = await created.value.persistEvent(event);
  return { result, attempts, elapsed: performance.now() - started };
};

// The fallback wait for the first retry is 25 to 50 ms; the server hint is 1 s.
const malformed = Uint8Array.from([10, 255]);
for (const entry of entries) {
  const waited = await persistOnce(entry, aborted([malformed, retryInfo({ seconds: 1 })]));
  assert.equal(waited.attempts, 2, entry[0]);
  assert.match(waited.result.error.message, /transaction failed/, entry[0]);
  assert.ok(waited.elapsed >= 1000, `${entry[0]} waited ${waited.elapsed} ms`);

  for (const delay of [{ seconds: 60, nanos: 1 }, { seconds: "315576000000", nanos: 999999999 }]) {
    const cause = aborted([retryInfo(delay)]);
    const stopped = await persistOnce(entry, cause);
    assert.equal(stopped.attempts, 1, entry[0]);
    assert.match(stopped.result.error.message, /server retry delay exceeds supported wait of 60000ms/, entry[0]);
    assert.equal(stopped.result.error.cause, cause, entry[0]);
  }

  const fallback = await persistOnce(entry, aborted([malformed]));
  assert.equal(fallback.attempts, 2, entry[0]);
  assert.ok(fallback.elapsed < 1000, `${entry[0]} fallback waited ${fallback.elapsed} ms`);
}
