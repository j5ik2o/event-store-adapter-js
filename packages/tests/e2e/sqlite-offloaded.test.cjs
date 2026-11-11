const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

// ビルドした入口を子プロセスで使う。ワーカーは dist の JavaScript を読み込む。
const script = (body) => `
  const { SqliteBlockingExecution, SqliteEventStore } = require("event-store-adapter-js/sqlite");
  const unwrap = (result) => { if (result.type === "err") throw new Error(result.error.message); return result.value; };
  const event = (seqNr) => ({ aggregateId: { typeName: "Order", value: "1" }, seqNr, occurredAt: new Date(0), manifest: "e", payload: { seqNr } });
  (async () => {
    const input = { path: process.argv[1] };
    unwrap(await SqliteEventStore.initialize(input));
    const execution = unwrap(SqliteBlockingExecution.singleWorker(4));
    const store = unwrap(await SqliteEventStore.createOffloaded(input, execution));
    ${body}
  })();
`;

const run = (body) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eswa-sqlite-offloaded-"));
  try {
    const result = spawnSync(process.execPath, ["-e", script(body), path.join(directory, "store.sqlite3")], { cwd: __dirname, encoding: "utf8", timeout: 20000 });
    return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
};

test("the worker keeps the process alive until an accepted operation answers, with nothing else to wait for", () => {
  const result = run(`
    unwrap(await store.persistEvent(event(1)));
    process.stdout.write(JSON.stringify(unwrap(await store.getEventsByIdSinceSeqNr(event(1).aggregateId, 1)).map((e) => e.seqNr)));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "[1]");
});

test("an idle execution that is never closed does not keep the process alive", () => {
  const result = run(`unwrap(await store.persistEvent(event(1))); process.stdout.write("appended");`);
  assert.equal(result.signal, null, "the process must exit by itself");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "appended");
});

test("drained settles after close, and an append whose promise nobody awaits has committed by then", () => {
  const result = run(`
    void store.persistEvent(event(1));
    unwrap(store.close());
    execution.close();
    await execution.drained();
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.path, { readOnly: true });
    process.stdout.write(String(db.prepare("SELECT count(*) AS n FROM journal").get().n));
    db.close();
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1");
});
