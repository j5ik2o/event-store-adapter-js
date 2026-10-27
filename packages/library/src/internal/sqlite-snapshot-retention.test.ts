import assert from "node:assert/strict";
import type { RetentionFailure } from "../retention-failure";
import { SqliteEventStore } from "../sqlite-event-store";
import type { SqliteEventStoreInput } from "../sqlite-event-store-input";
import { openSqliteEventStoreInternal } from "./sqlite-event-store";
import type { SqliteEventStoreHooks } from "./sqlite-event-store-hooks";
import {
  readSqliteRows,
  sqliteEventOf,
  sqliteSnapshotOf,
  sqliteTempDirectory,
  writeSqliteRows,
} from "./test/sqlite-fixture";

let temp: ReturnType<typeof sqliteTempDirectory>;
const opened: SqliteEventStore[] = [];
beforeEach(() => {
  temp = sqliteTempDirectory();
});
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  temp.remove();
});

type Input = Partial<SqliteEventStoreInput<unknown, unknown>>;

async function newStore(
  extra: Input,
  hooks?: SqliteEventStoreHooks,
): Promise<SqliteEventStore> {
  const full = { path: temp.file(), ...extra } as SqliteEventStoreInput<
    unknown,
    unknown
  >;
  const initialized = await SqliteEventStore.initialize(full);
  if (initialized.type === "err") throw new Error(initialized.error.message);
  const created = await openSqliteEventStoreInternal(full, hooks);
  if (created.type === "err") throw new Error(created.error.message);
  opened.push(created.value);
  return created.value;
}

const historySeqNrs = (): readonly bigint[] =>
  readSqliteRows(
    temp.file(),
    "SELECT seq_nr FROM snapshot_history WHERE aid = 'Order-1' ORDER BY seq_nr",
  ).map((r) => r.seq_nr as bigint);

async function appendSnapshots(
  store: SqliteEventStore,
  from: number,
  to: number,
): Promise<void> {
  for (let seq = from; seq <= to; seq++) {
    const result = await store.persistEventAndSnapshot(
      sqliteEventOf(seq),
      sqliteSnapshotOf(seq),
    );
    expect(result.type).toBe("ok");
  }
}

describe("successful retention (SQ-10)", () => {
  test("keeps only the newest n history rows and never touches current, head or journal", async () => {
    const store = await newStore({ retention: { count: 2 } });
    await appendSnapshots(store, 1, 5);
    expect(historySeqNrs()).toEqual([BigInt(4), BigInt(5)]);
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM snapshot_current")[0]
        ?.seq_nr,
    ).toBe(BigInt(5));
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM head")[0]?.seq_nr,
    ).toBe(BigInt(5));
    expect(
      readSqliteRows(temp.file(), "SELECT count(*) AS n FROM journal")[0]?.n,
    ).toBe(BigInt(5));
  });

  test("a store without retention writes no history rows, as the Rust layout does, but keeps current", async () => {
    const store = await newStore({});
    await appendSnapshots(store, 1, 3);
    expect(historySeqNrs()).toEqual([]);
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM snapshot_current")[0]
        ?.seq_nr,
    ).toBe(BigInt(3));
  });

  test("retention is applied per aggregate", async () => {
    const store = await newStore({ retention: { count: 1 } });
    await appendSnapshots(store, 1, 2);
    const other = { typeName: "Order", value: "2" };
    for (const seq of [1, 2]) {
      await store.persistEventAndSnapshot(
        sqliteEventOf(seq, other),
        sqliteSnapshotOf(seq),
      );
    }
    expect(
      readSqliteRows(
        temp.file(),
        "SELECT aid, seq_nr FROM snapshot_history ORDER BY aid",
      ).map((r) => [r.aid, r.seq_nr]),
    ).toEqual([
      ["Order-1", BigInt(2)],
      ["Order-2", BigInt(2)],
    ]);
  });
});

describe("retention failure (SQ-11, S-4)", () => {
  const failingDelete = (state: { fail: boolean }): SqliteEventStoreHooks => ({
    beforeRetentionDelete: () => {
      if (state.fail) throw new Error("injected retention failure");
    },
  });

  test("a failed cleanup keeps the append successful, notifies logger and callback, and is retried by the next snapshot write", async () => {
    const state = { fail: true };
    const failures: RetentionFailure[] = [];
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const store = await newStore(
      {
        retention: { count: 1 },
        onRetentionFailure: (f) => failures.push(f),
        logger,
      },
      failingDelete(state),
    );
    await appendSnapshots(store, 1, 1);
    await appendSnapshots(store, 2, 2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "retention-failure",
      aggregateId: "Order-1",
    });
    expect(logger.error).toHaveBeenCalled();
    // ROLLBACK 済み: 整理は何も反映されず、データも失われていない。
    expect(historySeqNrs()).toEqual([BigInt(1), BigInt(2)]);
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM head")[0]?.seq_nr,
    ).toBe(BigInt(2));
    state.fail = false;
    await appendSnapshots(store, 3, 3);
    expect(historySeqNrs()).toEqual([BigInt(3)]);
  });

  test("the connection is usable after a failed cleanup (no transaction left open)", async () => {
    const state = { fail: true };
    const store = await newStore(
      {
        retention: { count: 1 },
        onRetentionFailure: () => undefined,
        logger: {
          debug: jest.fn(),
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        },
      },
      failingDelete(state),
    );
    await appendSnapshots(store, 1, 2);
    const plain = await store.persistEvent(sqliteEventOf(3));
    expect(plain.type).toBe("ok");
    const read = await store.getEventsByIdSinceSeqNr(
      { typeName: "Order", value: "1" },
      1,
    );
    expect(read.type === "ok" && read.value.length).toBe(3);
  });

  test("a synchronous AssertionError from the callback does not turn the committed append into a failure", async () => {
    const state = { fail: true };
    const callback = jest.fn((_failure: RetentionFailure) => {
      assert.fail("callback assertion");
    });
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const store = await newStore(
      { retention: { count: 1 }, onRetentionFailure: callback, logger },
      failingDelete(state),
    );
    await appendSnapshots(store, 1, 1);
    const result = await store.persistEventAndSnapshot(
      sqliteEventOf(2),
      sqliteSnapshotOf(2),
    );
    expect(result.type).toBe("ok");
    // 通知経路が実際に呼ばれたことを確かめる。
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      kind: "retention-failure",
    });
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM head")[0]?.seq_nr,
    ).toBe(BigInt(2));
    expect(historySeqNrs()).toEqual([BigInt(1), BigInt(2)]);
  });

  test("an asynchronous rejection from the callback does not turn the committed append into a failure", async () => {
    const state = { fail: true };
    const callback = jest.fn(
      async (_failure: RetentionFailure): Promise<void> => {
        assert.fail("async callback assertion");
      },
    );
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const store = await newStore(
      {
        retention: { count: 1 },
        onRetentionFailure: callback as unknown as (
          f: RetentionFailure,
        ) => void,
        logger,
      },
      failingDelete(state),
    );
    await appendSnapshots(store, 1, 1);
    const result = await store.persistEventAndSnapshot(
      sqliteEventOf(2),
      sqliteSnapshotOf(2),
    );
    expect(result.type).toBe("ok");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM head")[0]?.seq_nr,
    ).toBe(BigInt(2));
  });

  test("a throwing logger and a throwing callback together still leave the append successful", async () => {
    const state = { fail: true };
    const callback = jest.fn(() => {
      throw new Error("callback");
    });
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(() => {
        throw new Error("logger");
      }),
    };
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const store = await newStore(
        { retention: { count: 1 }, onRetentionFailure: callback, logger },
        failingDelete(state),
      );
      await appendSnapshots(store, 1, 2);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalled();
      expect(
        readSqliteRows(temp.file(), "SELECT seq_nr FROM head")[0]?.seq_nr,
      ).toBe(BigInt(2));
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("a history row with an invalid number (SQ-11)", () => {
  test("is reported through the logger and onRetentionFailure, keeps the append successful, and deletes nothing", async () => {
    const failures: RetentionFailure[] = [];
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const store = await newStore({
      retention: { count: 1 },
      onRetentionFailure: (f) => failures.push(f),
      logger,
    });
    await appendSnapshots(store, 1, 1);
    writeSqliteRows(
      temp.file(),
      "PRAGMA ignore_check_constraints = ON; INSERT INTO snapshot_history (aid, seq_nr, manifest, payload) VALUES ('Order-1', 0, 'snapshot/v1', x'7b7d')",
    );
    const result = await store.persistEventAndSnapshot(
      sqliteEventOf(2),
      sqliteSnapshotOf(2),
    );
    expect(result.type).toBe("ok");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "retention-failure",
      aggregateId: "Order-1",
    });
    expect(logger.error).toHaveBeenCalled();
    expect(historySeqNrs()).toEqual([BigInt(0), BigInt(1), BigInt(2)]);
    expect(
      readSqliteRows(temp.file(), "SELECT seq_nr FROM head")[0]?.seq_nr,
    ).toBe(BigInt(2));
  });
});
