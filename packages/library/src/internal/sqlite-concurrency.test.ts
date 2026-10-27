import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventStore } from "../sqlite-event-store";
import { openSqliteEventStoreInternal } from "./sqlite-event-store";
import {
  readSqliteRows,
  sqliteEventOf,
  sqliteTempDirectory,
} from "./test/sqlite-fixture";

let temp = sqliteTempDirectory();
const opened: SqliteEventStore[] = [];
beforeEach(() => {
  temp = sqliteTempDirectory();
});
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  temp.remove();
});

async function newStore(
  lockWaitMilliseconds?: number,
): Promise<SqliteEventStore> {
  const input = {
    path: temp.file(),
    ...(lockWaitMilliseconds === undefined ? {} : { lockWaitMilliseconds }),
  };
  const initialized = await SqliteEventStore.initialize(input);
  if (initialized.type === "err") throw new Error(initialized.error.message);
  const created = await openSqliteEventStoreInternal(input);
  if (created.type === "err") throw new Error(created.error.message);
  opened.push(created.value);
  return created.value;
}

const countOf = (table: string): unknown =>
  readSqliteRows(temp.file(), `SELECT count(*) AS n FROM ${table}`)[0]?.n;

describe("lock wait (SQ-7, SQ-1)", () => {
  test("an append waits for the configured time while another connection holds the write lock, then fails as a storage error and commits nothing", async () => {
    const store = await newStore(300);
    const holder = new DatabaseSync(temp.file());
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const result = await store.persistEvent(sqliteEventOf(1));
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    // 待ち時間 300ms に対して許容誤差 10ms。待たずに失敗する実装を拒否する。
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(5000);
    holder.exec("ROLLBACK");
    holder.close();
    expect(countOf("journal")).toBe(BigInt(0));
    expect(countOf("head")).toBe(BigInt(0));
  });

  test("a busy append is never an optimistic lock conflict", async () => {
    const store = await newStore(50);
    const holder = new DatabaseSync(temp.file());
    holder.exec("BEGIN IMMEDIATE");
    const result = await store.persistEvent(sqliteEventOf(1));
    holder.exec("ROLLBACK");
    holder.close();
    expect(result.type).toBe("err");
    expect(result.type === "err" && result.error.type).not.toBe(
      "optimistic-lock-conflict",
    );
    expect(result.type === "err" && result.error.type).not.toBe(
      "contract-violation",
    );
  });

  test("the same append succeeds after the lock is released", async () => {
    const store = await newStore(50);
    const holder = new DatabaseSync(temp.file());
    holder.exec("BEGIN IMMEDIATE");
    expect((await store.persistEvent(sqliteEventOf(1))).type).toBe("err");
    holder.exec("ROLLBACK");
    holder.close();
    expect((await store.persistEvent(sqliteEventOf(1))).type).toBe("ok");
    expect(countOf("journal")).toBe(BigInt(1));
  });

  test("reads are not blocked by another connection's write lock (WAL)", async () => {
    const store = await newStore(50);
    expect((await store.persistEvent(sqliteEventOf(1))).type).toBe("ok");
    const holder = new DatabaseSync(temp.file());
    holder.exec("BEGIN IMMEDIATE");
    const read = await store.getEventsByIdSinceSeqNr(
      { typeName: "Order", value: "1" },
      1,
    );
    holder.exec("ROLLBACK");
    holder.close();
    expect(read.type === "ok" && read.value.length).toBe(1);
  });
});

describe("another process (W-8, SQ-5)", () => {
  // 子プロセスが seq 2 を書いたまま短時間ロックを保持し、その後に確定する。
  const childScript = (file: string): string => `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO journal (aid, seq_nr, occurred_at_ns, manifest, payload) VALUES ('Order-1', 2, 0, 'e', x'7b7d')");
    db.exec("UPDATE head SET seq_nr = 2 WHERE aid = 'Order-1'");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);
  `;

  test("an append that waited for another process to commit seq 2 is an optimistic lock conflict, not a storage error", async () => {
    const store = await newStore(5000);
    expect((await store.persistEvent(sqliteEventOf(1))).type).toBe("ok");
    const child = spawn(process.execPath, ["-e", childScript(temp.file())], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("locked")) resolve();
      });
      child.on("error", reject);
    });
    const result = await store.persistEvent(sqliteEventOf(2));
    expect(await exited).toBe(0);
    expect(result).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", seqNr: 2, headSeqNr: 2 },
    });
    expect(countOf("journal")).toBe(BigInt(2));
    expect((await store.persistEvent(sqliteEventOf(3))).type).toBe("ok");
  }, 30000);
});
