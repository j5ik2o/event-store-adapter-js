import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { SqliteEventStore } from "../sqlite-event-store";
import {
  restoreWireResult,
  SQLITE_WORKER_SHUTDOWN,
  type SqliteWorkerRequest,
  serveSqliteWorkerRequests,
} from "./sqlite-worker-requests";
import { sqliteTempDirectory } from "./test/sqlite-fixture";

// ワーカーの中で動く処理を、呼び出し元のスレッドの MessageChannel で直接確かめる。
let temp: ReturnType<typeof sqliteTempDirectory>;
let port: MessagePort;
let closed: Promise<void>;
let shutDown = false;
beforeEach(async () => {
  temp = sqliteTempDirectory();
  const channel = new MessageChannel();
  serveSqliteWorkerRequests(channel.port2);
  port = channel.port1;
  closed = new Promise((resolve) => port.once("close", () => resolve()));
  shutDown = false;
  const initialized = await SqliteEventStore.initialize({
    path: temp.file(),
    retention: { count: 2 },
  });
  if (initialized.type === "err") throw new Error(initialized.error.message);
});
afterEach(async () => {
  if (!shutDown) await shutdown();
  temp.remove();
});

const shutdown = async () => {
  shutDown = true;
  port.postMessage(SQLITE_WORKER_SHUTDOWN);
  await closed;
};

// 最後の接続が閉じると、SQLite は WAL を本体へ移して -wal ファイルを消す。
const walExists = () => existsSync(`${temp.file()}-wal`);

const ask = (request: SqliteWorkerRequest): Promise<unknown> =>
  new Promise((resolve) => {
    port.once("message", resolve);
    port.postMessage(request);
  });

const open = (path = temp.file()) =>
  ask({ kind: "open", path, lockWaitMilliseconds: 0, retentionCount: 2 });

const append = (connection: number) =>
  ask({
    kind: "append",
    connection,
    append: {
      rows: {
        aid: "Order-1",
        typeName: "Order",
        seqNr: 1,
        nanos: BigInt(0),
        manifest: "event/v1",
        payload: Buffer.from("{}"),
        snapshot: {
          seqNr: 1,
          manifest: "snapshot/v1",
          payload: Buffer.from("{}"),
        },
        keepHistory: true,
      },
      retention: { seqNr: 1, count: 2 },
    },
  });

describe("requests to the SQLite worker", () => {
  test("each open gets its own connection number, and a failed open gets none", async () => {
    expect(await open()).toEqual({ type: "ok", value: 1 });
    expect(await open(temp.file("missing.sqlite3"))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(await open()).toEqual({ type: "ok", value: 2 });
  });

  test("an append on a busy file carries the SQLite error fields of the cause, which restoreWireResult puts back", async () => {
    const connection = 1;
    await open();
    const holder = new DatabaseSync(temp.file());
    holder.exec("BEGIN IMMEDIATE");
    const answer = (await append(connection)) as {
      appended: Parameters<typeof restoreWireResult>[0];
      retained: unknown;
    };
    holder.exec("ROLLBACK");
    holder.close();
    expect(answer.retained).toBeUndefined();
    expect(answer.appended).toMatchObject({
      type: "err",
      error: {
        type: "storage-error",
        causeProperties: { errcode: 5, code: "ERR_SQLITE_ERROR" },
      },
    });
    const restored = restoreWireResult(answer.appended);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(restored.type === "err" && Object.isFrozen(restored.error)).toBe(
      true,
    );
    expect(restored).toMatchObject({
      type: "err",
      error: { type: "storage-error", cause: { errcode: 5 } },
    });
    expect(restored.type === "err" && "causeProperties" in restored.error).toBe(
      false,
    );
  });

  test("an append that commits also answers the retention result", async () => {
    await open();
    expect(await append(1)).toEqual({
      appended: { type: "ok", value: undefined },
      retained: { type: "ok", value: undefined },
    });
  });

  test("a connection number that is not open is a closed store for every operation, and closing it twice is harmless", async () => {
    await open();
    expect(await ask({ kind: "close", connection: 1 })).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(await ask({ kind: "close", connection: 1 })).toEqual({
      type: "ok",
      value: undefined,
    });
    const closedStore = {
      type: "err",
      error: { type: "storage-error", message: "SQLite store is closed" },
    };
    expect(await append(1)).toEqual({
      appended: closedStore,
      retained: undefined,
    });
    expect(
      await ask({
        kind: "read-events",
        connection: 1,
        aid: "Order-1",
        start: 1,
      }),
    ).toEqual(closedStore);
    expect(
      await ask({ kind: "read-snapshot", connection: 1, aid: "Order-1" }),
    ).toEqual(closedStore);
  });

  test("reads answer the rows as values that can cross threads", async () => {
    await open();
    await append(1);
    expect(
      await ask({
        kind: "read-events",
        connection: 1,
        aid: "Order-1",
        start: 0,
      }),
    ).toMatchObject({
      type: "ok",
      value: {
        from: BigInt(1),
        head: BigInt(1),
        rows: [{ seq_nr: BigInt(1) }],
      },
    });
    expect(
      await ask({ kind: "read-snapshot", connection: 1, aid: "Order-1" }),
    ).toMatchObject({
      type: "ok",
      value: {
        headRow: { seq_nr: BigInt(1) },
        currentRow: { seq_nr: BigInt(1) },
      },
    });
  });

  test("close and shutdown close the connections", async () => {
    await open();
    await open();
    await append(1);
    await ask({ kind: "close", connection: 1 });
    expect(walExists()).toBe(true);
    await shutdown();
    expect(walExists()).toBe(false);
  });
});
