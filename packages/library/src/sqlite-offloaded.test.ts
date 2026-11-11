import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EventStore } from "./event-store";
import type { EventStoreError } from "./event-store-error";
import {
  readSqliteRows,
  sqliteEventOf,
  sqliteSnapshotOf,
  sqliteTempDirectory,
  writeSqliteRows,
} from "./internal/test/sqlite-fixture";
import type { Result } from "./result";
import { SqliteBlockingExecution, SqliteEventStore } from "./sqlite";
import type { SqliteEventStoreInput } from "./sqlite-event-store-input";

let temp: ReturnType<typeof sqliteTempDirectory>;
let executions: SqliteBlockingExecution[] = [];
let holders: DatabaseSync[] = [];
beforeEach(() => {
  temp = sqliteTempDirectory();
});
afterEach(async () => {
  for (const holder of holders) if (holder.isOpen) holder.close();
  holders = [];
  for (const execution of executions) execution.close();
  await Promise.all(executions.map((execution) => execution.drained()));
  executions = [];
  temp.remove();
});

const unwrap = <T>(result: Result<T, EventStoreError>): T => {
  if (result.type === "err") throw new Error(result.error.message);
  return result.value;
};

const newExecution = (queueCapacity = 8): SqliteBlockingExecution => {
  const execution = unwrap(SqliteBlockingExecution.singleWorker(queueCapacity));
  executions = [...executions, execution];
  return execution;
};

const initialized = async (
  input: SqliteEventStoreInput<unknown, unknown>,
): Promise<SqliteEventStoreInput<unknown, unknown>> => {
  unwrap(await SqliteEventStore.initialize(input));
  return input;
};

const offloaded = async (
  execution: SqliteBlockingExecution,
  extra: Partial<SqliteEventStoreInput<unknown, unknown>> = {},
): Promise<SqliteEventStore> =>
  unwrap(
    await SqliteEventStore.createOffloaded(
      await initialized({ path: temp.file(), ...extra }),
      execution,
    ),
  );

/** 別の接続で書き込みロックを取る。 */
const holdWriteLock = (): DatabaseSync => {
  const holder = new DatabaseSync(temp.file());
  holder.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  holders = [...holders, holder];
  return holder;
};

const countOf = (table: string): unknown =>
  readSqliteRows(temp.file(), `SELECT count(*) AS n FROM ${table}`)[0]?.n;

const order = { typeName: "Order", value: "1" };
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createOffloaded keeps SQLite I/O off the calling thread (L-1)", () => {
  const watchCallingThread = () => {
    const spies = (["exec", "prepare", "close"] as const).map((name) =>
      jest.spyOn(DatabaseSync.prototype, name),
    );
    return {
      calls: () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0),
      restore: () => {
        for (const spy of spies) spy.mockRestore();
      },
    };
  };

  test("the detector sees DatabaseSync calls on the calling thread when the store comes from create", async () => {
    const input = await initialized({
      path: temp.file(),
      retention: { count: 1 },
    });
    const watch = watchCallingThread();
    try {
      const store = unwrap(await SqliteEventStore.create(input));
      unwrap(await store.persistEvent(sqliteEventOf(1)));
      store.close();
      expect(watch.calls()).toBeGreaterThan(0);
    } finally {
      watch.restore();
    }
  });

  test("open, the four operations, retention and close make no DatabaseSync call on the calling thread", async () => {
    const input = await initialized({
      path: temp.file(),
      retention: { count: 1 },
    });
    const watch = watchCallingThread();
    let calls: number;
    try {
      const execution = newExecution();
      const store = unwrap(
        await SqliteEventStore.createOffloaded(input, execution),
      );
      unwrap(await store.persistEvent(sqliteEventOf(1)));
      unwrap(
        await store.persistEventAndSnapshot(
          sqliteEventOf(2),
          sqliteSnapshotOf(2),
        ),
      );
      unwrap(
        await store.persistEventAndSnapshot(
          sqliteEventOf(3),
          sqliteSnapshotOf(3),
        ),
      );
      expect(unwrap(await store.getLatestSnapshotById(order))).toMatchObject({
        headSeqNr: 3,
        snapshot: { seqNr: 3 },
      });
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(order, 1)).map(
          (event) => event.seqNr,
        ),
      ).toEqual([1, 2, 3]);
      store.close();
      execution.close();
      await execution.drained();
      calls = watch.calls();
    } finally {
      watch.restore();
    }
    expect(calls).toBe(0);
    // 保持の件数 1 なので、整理で seq 2 の履歴が消えている。
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM snapshot_history"),
    ).toEqual([{ seq_nr: BigInt(3) }]);
  });

  test("timers run while an append waits for another connection's write lock, and a timer that releases the lock lets the append commit", async () => {
    const execution = newExecution();
    const store = await offloaded(execution, { lockWaitMilliseconds: 3000 });
    const holder = holdWriteLock();
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    setTimeout(() => holder.exec("ROLLBACK"), 200);
    const started = performance.now();
    const result = await store.persistEvent(sqliteEventOf(1));
    const elapsed = performance.now() - started;
    clearInterval(ticker);
    // 呼び出し元のスレッドで待つと、ロックを外すタイマーが動かず、3000ms 待って保存先エラーになる。
    expect(result).toEqual({ type: "ok", value: undefined });
    expect(elapsed).toBeLessThan(3000);
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(countOf("journal")).toBe(BigInt(1));
  });
});

describe("the bounded queue of SqliteBlockingExecution", () => {
  test("with room for one waiting operation, a third operation is rejected without running while one runs and one waits, and a pending store close takes no room", async () => {
    const execution = newExecution(1);
    const store = await offloaded(execution, { lockWaitMilliseconds: 3000 });
    const other = unwrap(
      await SqliteEventStore.createOffloaded(
        await initialized({ path: temp.file("other.sqlite3") }),
        execution,
      ),
    );
    const holder = holdWriteLock();
    const running = store.persistEvent(sqliteEventOf(1, order));
    other.close();
    const waiting = store.persistEvent(
      sqliteEventOf(1, { typeName: "Order", value: "2" }),
    );
    const rejected = await store.persistEvent(
      sqliteEventOf(1, { typeName: "Order", value: "3" }),
    );
    expect(rejected).toEqual({
      type: "err",
      error: {
        type: "storage-error",
        message: "SQLite blocking execution is full",
      },
    });
    holder.exec("ROLLBACK");
    expect((await running).type).toBe("ok");
    expect((await waiting).type).toBe("ok");
    expect(
      readSqliteRows(temp.file(), "SELECT aid FROM journal ORDER BY aid"),
    ).toEqual([{ aid: "Order-1" }, { aid: "Order-2" }]);
  });

  test("after close, operations and createOffloaded are rejected without running, and close can be called again", async () => {
    const execution = newExecution();
    const store = await offloaded(execution);
    execution.close();
    execution.close();
    const closed = {
      type: "err",
      error: {
        type: "storage-error",
        message: "SQLite blocking execution is closed",
      },
    };
    expect(await store.persistEvent(sqliteEventOf(1))).toEqual(closed);
    expect(await store.getEventsByIdSinceSeqNr(order, 1)).toEqual(closed);
    expect(await store.getLatestSnapshotById(order)).toEqual(closed);
    expect(
      await SqliteEventStore.createOffloaded({ path: temp.file() }, execution),
    ).toEqual(closed);
    await execution.drained();
    expect(countOf("journal")).toBe(BigInt(0));
  });

  test("operations run in the order they were accepted", async () => {
    const execution = newExecution();
    const store = await offloaded(execution);
    const finished: string[] = [];
    const track = <T>(label: string, operation: Promise<T>): Promise<T> =>
      operation.then((value) => {
        finished.push(label);
        return value;
      });
    const operations = [
      track("append 1", store.persistEvent(sqliteEventOf(1))),
      track("read after 1", store.getEventsByIdSinceSeqNr(order, 1)),
      track(
        "append 2",
        store.persistEventAndSnapshot(sqliteEventOf(2), sqliteSnapshotOf(2)),
      ),
      track("read after 2", store.getEventsByIdSinceSeqNr(order, 1)),
      track("snapshot after 2", store.getLatestSnapshotById(order)),
    ] as const;
    const [, afterOne, , afterTwo, snapshot] = await Promise.all(operations);
    expect(finished).toEqual([
      "append 1",
      "read after 1",
      "append 2",
      "read after 2",
      "snapshot after 2",
    ]);
    expect(unwrap(afterOne).map((event) => event.seqNr)).toEqual([1]);
    expect(unwrap(afterTwo).map((event) => event.seqNr)).toEqual([1, 2]);
    expect(unwrap(snapshot)).toMatchObject({ headSeqNr: 2 });
  });

  test("drained settles only after close and after every accepted operation has finished", async () => {
    const execution = newExecution();
    const store = await offloaded(execution, { lockWaitMilliseconds: 3000 });
    const holder = holdWriteLock();
    let appended = false;
    const append = store.persistEvent(sqliteEventOf(1)).then((result) => {
      appended = true;
      return result;
    });
    let drained = false;
    const settled = execution.drained().then(() => {
      drained = true;
    });
    await sleep(50);
    expect(drained).toBe(false);
    execution.close();
    await sleep(50);
    expect(drained).toBe(false);
    holder.exec("ROLLBACK");
    await settled;
    expect(appended).toBe(true);
    expect((await append).type).toBe("ok");
  });

  test("an accepted append whose promise nobody awaits still commits", async () => {
    const execution = newExecution();
    const store = await offloaded(execution, { lockWaitMilliseconds: 3000 });
    const holder = holdWriteLock();
    void store.persistEvent(sqliteEventOf(1));
    store.close();
    execution.close();
    holder.exec("ROLLBACK");
    await execution.drained();
    expect(countOf("journal")).toBe(BigInt(1));
  });
});

describe("arguments of the offloaded entry", () => {
  test.each([0, -1, 1.5, Number.NaN, "1" as unknown as number])(
    "singleWorker(%p) is a configuration error",
    (queueCapacity) => {
      expect(SqliteBlockingExecution.singleWorker(queueCapacity)).toEqual({
        type: "err",
        error: {
          type: "configuration-error",
          fieldName: "queueCapacity",
          message: "queueCapacity must be a positive safe integer",
        },
      });
    },
  );

  test("an execution not created by singleWorker is a configuration error", async () => {
    const fake: SqliteBlockingExecution = {
      close: () => undefined,
      drained: async () => undefined,
    };
    expect(
      await SqliteEventStore.createOffloaded({ path: temp.file() }, fake),
    ).toEqual({
      type: "err",
      error: {
        type: "configuration-error",
        fieldName: "execution",
        message:
          "execution must be created by SqliteBlockingExecution.singleWorker",
      },
    });
  });

  test("an invalid input is reported before the execution is used", async () => {
    const execution = newExecution();
    execution.close();
    expect(
      await SqliteEventStore.createOffloaded(
        { path: temp.file(), changeFeed: true },
        execution,
      ),
    ).toMatchObject({ type: "err", error: { type: "configuration-error" } });
  });
});

describe("createOffloaded gives the same results as create (L-2)", () => {
  type Store = EventStore<unknown, unknown> &
    Readonly<{ close(): Result<void, EventStoreError> }>;
  type Scenario = Readonly<{
    file: string;
    store: Store;
    notifications: () => readonly string[];
  }>;

  // payload が "bad" のものは直列化に失敗し、manifest が "broken" のものは復元に失敗する。
  const serializer = {
    serialize: (payload: unknown) => {
      if (payload === "bad") throw new Error("cannot serialize");
      return new TextEncoder().encode(JSON.stringify(payload));
    },
    deserialize: (bytes: Uint8Array, manifest: string) => {
      if (manifest === "broken") throw new Error("cannot deserialize");
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  };

  const open = async (
    name: string,
    via: (
      input: SqliteEventStoreInput<unknown, unknown>,
    ) => Promise<Result<SqliteEventStore, EventStoreError>>,
  ): Promise<Scenario> => {
    const file = temp.file(name);
    let notifications: string[] = [];
    const input: SqliteEventStoreInput<unknown, unknown> = {
      path: file,
      eventSerializer: serializer,
      snapshotSerializer: serializer,
      retention: { count: 1 },
      lockWaitMilliseconds: 50,
      onRetentionFailure: (failure) => {
        notifications = [...notifications, failure.kind];
      },
      logger: { ...console, error: () => undefined },
    };
    unwrap(await SqliteEventStore.initialize(input));
    return {
      file,
      store: unwrap(await via(input)),
      notifications: () => notifications,
    };
  };

  /** 同じ手順を流し、結果をすべて集める。cause は errcode などの欄も比べる。 */
  const run = async (scenario: Scenario): Promise<unknown[]> => {
    const { store, file } = scenario;
    const event = (seqNr: number, overrides: object = {}) => ({
      ...sqliteEventOf(seqNr),
      ...overrides,
    });
    const results: unknown[] = [
      await store.getEventsByIdSinceSeqNr(order, 0),
      await store.getLatestSnapshotById(order),
      await store.persistEvent(event(1)),
      await store.persistEvent(event(1)),
      await store.persistEvent(event(3)),
      await store.persistEvent(event(2, { payload: "bad" })),
      await store.persistEventAndSnapshot(event(2), sqliteSnapshotOf(2)),
      await store.persistEventAndSnapshot(event(3), {
        ...sqliteSnapshotOf(3),
        aggregate: "bad",
      }),
      await store.persistEventAndSnapshot(event(3), sqliteSnapshotOf(3)),
      await store.getEventsByIdSinceSeqNr(order, 0),
      await store.getEventsByIdSinceSeqNr(order, 3),
      await store.getEventsByIdSinceSeqNr(order, 4),
      await store.getLatestSnapshotById(order),
      await store.getLatestSnapshotById({ typeName: "Missing", value: "1" }),
      await store.persistEvent({ ...event(4), seqNr: -1 }),
    ];
    // 整理の削除を失敗させて、確定済みの追記は成功のまま通知だけが届くことを比べる。
    writeSqliteRows(
      file,
      "CREATE TRIGGER keep_history BEFORE DELETE ON snapshot_history BEGIN SELECT RAISE(ABORT, 'history is kept'); END",
    );
    results.push(
      await store.persistEventAndSnapshot(event(4), sqliteSnapshotOf(4)),
      scenario.notifications(),
    );
    writeSqliteRows(file, "UPDATE journal SET manifest = 'broken'");
    results.push(await store.getEventsByIdSinceSeqNr(order, 1));
    writeSqliteRows(file, "UPDATE snapshot_current SET manifest = 'broken'");
    results.push(await store.getLatestSnapshotById(order));
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN IMMEDIATE");
    holders = [...holders, holder];
    results.push(await store.persistEvent(event(5)));
    holder.exec("ROLLBACK");
    results.push(
      await store.persistEventAndSnapshot(event(5), sqliteSnapshotOf(4)),
      await store.getLatestSnapshotById({ typeName: "Or-der", value: "1" }),
      await store.getEventsByIdSinceSeqNr(
        { typeName: "Or-der", value: "1" },
        0,
      ),
      await store.getEventsByIdSinceSeqNr(order, -1),
      [
        "SELECT aid, seq_nr, occurred_at_ns, manifest, payload FROM journal ORDER BY seq_nr",
        "SELECT * FROM head",
        "SELECT * FROM snapshot_current",
        "SELECT * FROM snapshot_history ORDER BY seq_nr",
      ].map((sql) => readSqliteRows(file, sql)),
    );
    // 表を消して、読み取りの SQL の失敗を比べる。
    writeSqliteRows(file, "DROP TABLE journal; DROP TABLE snapshot_current");
    results.push(
      await store.getEventsByIdSinceSeqNr(order, 0),
      await store.getLatestSnapshotById(order),
    );
    store.close();
    results.push(
      store.close(),
      await store.persistEvent(event(5)),
      await store.persistEventAndSnapshot(event(5), sqliteSnapshotOf(5)),
      await store.getEventsByIdSinceSeqNr(order, 0),
      await store.getLatestSnapshotById(order),
    );
    return results.map(observable);
  };

  /** 結果と、凍結の有無と、cause の欄を、比べられる形にする。 */
  const observable = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    if (Error.isError(value))
      return {
        name: value.name,
        message: value.message,
        properties: { ...value },
      };
    if (value instanceof Date) return value.toISOString();
    return {
      frozen: Object.isFrozen(value),
      entries: Object.entries(value).map(([key, item]) => [
        key,
        observable(item),
      ]),
    };
  };

  test("the same scenario on create and on createOffloaded yields equal results, errors, freezing, notifications and stored rows", async () => {
    const direct = await open("direct.sqlite3", SqliteEventStore.create);
    const execution = newExecution();
    const viaWorker = await open("offloaded.sqlite3", (input) =>
      SqliteEventStore.createOffloaded(input, execution),
    );
    const expected = await run(direct);
    const actual = await run(viaWorker);
    expect(actual).toEqual(expected);
    // 書き込みロックの待ちの超過（SQLITE_BUSY）の cause の欄も、スレッドを越えて残っている。
    expect(
      JSON.stringify(actual, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).toContain('"errcode":5');
  });

  test("opening a missing file or a file whose configuration differs gives the same error", async () => {
    const execution = newExecution();
    const missing = { path: temp.file("missing.sqlite3") };
    expect(await SqliteEventStore.createOffloaded(missing, execution)).toEqual(
      await SqliteEventStore.create(missing),
    );
    const input = await initialized({ path: temp.file() });
    const mismatched = { ...input, retention: { count: 2 } };
    expect(
      await SqliteEventStore.createOffloaded(mismatched, execution),
    ).toEqual(await SqliteEventStore.create(mismatched));
  });

  test("stores that share one execution keep their own connections, and closing one store closes only its connection after its accepted operations", async () => {
    const execution = newExecution();
    const first = await offloaded(execution);
    const second = unwrap(
      await SqliteEventStore.createOffloaded(
        await initialized({ path: temp.file("second.sqlite3") }),
        execution,
      ),
    );
    const appended = first.persistEvent(sqliteEventOf(1));
    first.close();
    expect((await appended).type).toBe("ok");
    unwrap(await second.persistEvent(sqliteEventOf(1)));
    // 最後の接続が閉じると、SQLite は WAL を本体へ移して -wal ファイルを消す。
    // 後から出した second の操作が終わった時点で、first の接続は閉じている。
    expect(existsSync(`${temp.file()}-wal`)).toBe(false);
    expect(existsSync(`${temp.file("second.sqlite3")}-wal`)).toBe(true);
    expect(unwrap(await second.getEventsByIdSinceSeqNr(order, 1))).toHaveLength(
      1,
    );
    expect(countOf("journal")).toBe(BigInt(1));
  });

  test("a closed store reports that it is closed even after the execution has closed", async () => {
    const execution = newExecution();
    const store = await offloaded(execution);
    store.close();
    execution.close();
    const closedStore = {
      type: "err",
      error: { type: "storage-error", message: "SQLite store is closed" },
    };
    expect(await store.persistEvent(sqliteEventOf(1))).toEqual(closedStore);
    expect(
      await store.persistEventAndSnapshot(
        sqliteEventOf(1),
        sqliteSnapshotOf(1),
      ),
    ).toEqual(closedStore);
    expect(await store.getEventsByIdSinceSeqNr(order, 1)).toEqual(closedStore);
    expect(await store.getLatestSnapshotById(order)).toEqual(closedStore);
  });
});
