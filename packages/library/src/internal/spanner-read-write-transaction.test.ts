import { EventStoreError } from "../event-store-error";
import { runSpannerReadWriteTransaction } from "./spanner-read-write-transaction";
import { SpannerTransactionRejection } from "./spanner-transaction-rejection";

const aborted = () => Object.assign(new Error("aborted"), { code: 10 });

function fakeDatabase(setup?: (tx: { commit: jest.Mock }) => void) {
  const transactions: {
    commit: jest.Mock;
    rollback: jest.Mock;
    end: jest.Mock;
  }[] = [];
  const getTransaction = jest.fn(async (_options?: unknown) => {
    const tx = {
      commit: jest.fn(async () => undefined),
      rollback: jest.fn(async () => undefined),
      end: jest.fn(),
    };
    setup?.(tx);
    transactions.push(tx);
    return [tx];
  });
  return {
    database: { getTransaction } as never,
    getTransaction,
    transactions,
  };
}

test("opens a SERIALIZABLE read-write transaction, commits and ends it", async () => {
  const { database, getTransaction, transactions } = fakeDatabase();
  const attempt = jest.fn(async () => "done");

  const result = await runSpannerReadWriteTransaction(database, 5, attempt);

  expect(result).toEqual({ type: "ok", value: "done" });
  expect(getTransaction).toHaveBeenCalledTimes(1);
  const options = getTransaction.mock.calls[0][0] as {
    isolationLevel: unknown;
  };
  expect([1, "SERIALIZABLE"]).toContain(options.isolationLevel);
  expect(transactions[0].commit).toHaveBeenCalledTimes(1);
  expect(transactions[0].end).toHaveBeenCalled();
});

test("retries ABORTED up to the limit with a fresh transaction per attempt", async () => {
  const { database, getTransaction, transactions } = fakeDatabase();
  let calls = 0;
  const attempt = jest.fn(async () => {
    calls += 1;
    if (calls <= 2) throw aborted();
    return "ok";
  });

  const result = await runSpannerReadWriteTransaction(database, 3, attempt);

  expect(result).toEqual({ type: "ok", value: "ok" });
  expect(attempt).toHaveBeenCalledTimes(3);
  expect(getTransaction).toHaveBeenCalledTimes(3);
  for (const tx of transactions) expect(tx.end).toHaveBeenCalled();
  expect(transactions[0].commit).not.toHaveBeenCalled();
  expect(transactions[2].commit).toHaveBeenCalledTimes(1);
});

test("returns a storage error when ABORTED exceeds the retry limit (the first attempt is not counted)", async () => {
  const { database, transactions } = fakeDatabase();
  const attempt = jest.fn(async () => {
    throw aborted();
  });

  const result = await runSpannerReadWriteTransaction(database, 2, attempt);

  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  expect(attempt).toHaveBeenCalledTimes(3);
  for (const tx of transactions) {
    expect(tx.commit).not.toHaveBeenCalled();
    expect(tx.end).toHaveBeenCalled();
  }
});

test("a retry limit of zero does not retry", async () => {
  const { database } = fakeDatabase();
  const attempt = jest.fn(async () => {
    throw aborted();
  });
  const result = await runSpannerReadWriteTransaction(database, 0, attempt);
  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  expect(attempt).toHaveBeenCalledTimes(1);
});

test("does not retry a failure other than ABORTED and rolls the transaction back", async () => {
  const { database, transactions } = fakeDatabase();
  const attempt = jest.fn(async () => {
    throw Object.assign(new Error("boom"), { code: 13 });
  });

  const result = await runSpannerReadWriteTransaction(database, 5, attempt);

  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(transactions[0].rollback).toHaveBeenCalledTimes(1);
  expect(transactions[0].end).toHaveBeenCalled();
});

test("calls beforeCommit before commit and afterCommit only after a successful commit", async () => {
  const order: string[] = [];
  const { database } = fakeDatabase((tx) => {
    tx.commit.mockImplementation(async () => {
      order.push("commit");
    });
  });
  const hooks = {
    beforeCommit: jest.fn(async () => {
      order.push("before");
    }),
    afterCommit: jest.fn(async () => {
      order.push("after");
    }),
  };
  await runSpannerReadWriteTransaction(database, 1, async () => "x", hooks);
  expect(order).toEqual(["before", "commit", "after"]);
});

test("a beforeCommit failure does not commit", async () => {
  const { database, transactions } = fakeDatabase();
  const hooks = {
    beforeCommit: jest.fn(async () => {
      throw new Error("injected");
    }),
  };
  const result = await runSpannerReadWriteTransaction(
    database,
    5,
    async () => "x",
    hooks,
  );
  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  expect(transactions[0].commit).not.toHaveBeenCalled();
  expect(hooks.beforeCommit).toHaveBeenCalledTimes(1);
});

test("an afterCommit failure is a storage error with unknown outcome: no retry, no rollback, no compensation", async () => {
  const { database, getTransaction, transactions } = fakeDatabase();
  const attempt = jest.fn(async () => "x");
  const hooks = {
    afterCommit: jest.fn(async () => {
      throw new Error("response lost");
    }),
  };

  const result = await runSpannerReadWriteTransaction(
    database,
    5,
    attempt,
    hooks,
  );

  expect(result).toMatchObject({
    type: "err",
    error: {
      type: "storage-error",
      message: expect.stringContaining("unknown"),
    },
  });
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(getTransaction).toHaveBeenCalledTimes(1);
  expect(transactions[0].commit).toHaveBeenCalledTimes(1);
  expect(transactions[0].rollback).not.toHaveBeenCalled();
});

test("a transaction that cannot be acquired is a storage error: no attempt, no retry, nothing to release", async () => {
  const cause = new Error("session unavailable");
  const getTransaction = jest.fn(async () => {
    throw cause;
  });
  const attempt = jest.fn(async () => "x");

  const result = await runSpannerReadWriteTransaction(
    { getTransaction } as never,
    5,
    attempt,
  );

  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error", cause },
  });
  expect(getTransaction).toHaveBeenCalledTimes(1);
  expect(attempt).not.toHaveBeenCalled();
});

function virtualClock() {
  let time = 0;
  return {
    now: () => time,
    random: jest.fn(() => 0),
    sleep: jest.fn(async (ms: number) => {
      time += ms;
    }),
  };
}

test.each([0, 1, 5])(
  "exhaustion for L=%i precedes metadata, randomness and final wait",
  async (limit) => {
    const clock = virtualClock();
    const { database, getTransaction } = fakeDatabase();
    const get = jest.fn(() => []);
    const cause = Object.assign(aborted(), { metadata: { get } });
    const result = await runSpannerReadWriteTransaction(
      database,
      limit,
      async () => {
        throw cause;
      },
      undefined,
      clock,
    );
    expect(result).toMatchObject({
      type: "err",
      error: { cause, message: expect.stringContaining("limit exceeded") },
    });
    expect(getTransaction).toHaveBeenCalledTimes(limit + 1);
    expect(get).toHaveBeenCalledTimes(limit);
    expect(clock.random).toHaveBeenCalledTimes(limit);
    expect(clock.sleep).toHaveBeenCalledTimes(limit);
  },
);

test("waits only after rollback resolves and end, before opening fresh transaction", async () => {
  const clock = virtualClock();
  const { database, getTransaction, transactions } = fakeDatabase();
  let release: () => void = () => {};
  const rollbackPending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resume: () => void = () => {};
  const pendingSleep = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let now = 0;
  clock.now = () => now;
  clock.sleep.mockReset().mockImplementation(async (ms) => {
    await pendingSleep;
    now += ms;
  });
  let calls = 0;
  const operation = runSpannerReadWriteTransaction(
    database,
    1,
    async () => {
      if (++calls === 1) {
        transactions[0].rollback.mockImplementation(() => rollbackPending);
        throw aborted();
      }
      return "done";
    },
    undefined,
    clock,
  );
  await new Promise(setImmediate);
  expect(clock.sleep).not.toHaveBeenCalled();
  expect(transactions[0].end).not.toHaveBeenCalled();
  release();
  await new Promise(setImmediate);
  expect(transactions[0].end).toHaveBeenCalledTimes(1);
  expect(clock.sleep).toHaveBeenCalledTimes(1);
  expect(getTransaction).toHaveBeenCalledTimes(1);
  resume();
  expect(await operation).toEqual({ type: "ok", value: "done" });
  expect(getTransaction).toHaveBeenCalledTimes(2);
});

test.each(["acquire", "after", "domain", "nonAborted"])(
  "%s failures never decode or wait",
  async (phase) => {
    const clock = virtualClock();
    const cause = aborted();
    const { database, getTransaction } = fakeDatabase();
    if (phase === "acquire") getTransaction.mockRejectedValue(cause);
    const domain = EventStoreError.storage("domain");
    const result = await runSpannerReadWriteTransaction(
      database,
      5,
      async () => {
        if (phase === "domain") throw new SpannerTransactionRejection(domain);
        if (phase === "nonAborted") throw { code: "10" };
        return "ok";
      },
      {
        afterCommit: async () => {
          if (phase === "after") throw cause;
        },
      },
      clock,
    );
    expect(result.type).toBe("err");
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(clock.random).not.toHaveBeenCalled();
    expect(clock.sleep).not.toHaveBeenCalled();
  },
);

test("rollback rejection preserves abort; end throw preserves precedence; sleep rejection stops", async () => {
  const { database, transactions } = fakeDatabase();
  const clock = virtualClock();
  const failedSleep = Error("sleep failed");
  clock.sleep.mockRejectedValue(failedSleep);
  const result = await runSpannerReadWriteTransaction(
    database,
    1,
    async () => {
      transactions[0].rollback.mockRejectedValue(Error("rollback"));
      throw aborted();
    },
    undefined,
    clock,
  );
  expect(result).toMatchObject({
    type: "err",
    error: { cause: failedSleep, message: "transaction retry wait failed" },
  });
  const endError = Error("end");
  await expect(
    runSpannerReadWriteTransaction(
      database,
      1,
      async () => {
        transactions[1].end.mockImplementation(() => {
          throw endError;
        });
        throw aborted();
      },
      undefined,
      clock,
    ),
  ).rejects.toBe(endError);
  expect(clock.sleep).toHaveBeenCalledTimes(1);
});

test("early timer wake reserves remainder before the next body and success hooks run once", async () => {
  let now = 0;
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sleep = jest.fn(async (_ms: number) => {
    if (sleep.mock.calls.length === 1) {
      now = 0.25;
      return;
    }
    await pending;
    now = 25;
  });
  const { database, getTransaction } = fakeDatabase();
  const beforeCommit = jest.fn();
  const afterCommit = jest.fn();
  const attempt = jest
    .fn()
    .mockRejectedValueOnce(aborted())
    .mockResolvedValue("ok");
  const operation = runSpannerReadWriteTransaction(
    database,
    5,
    attempt,
    { beforeCommit, afterCommit },
    { now: () => now, random: () => 0, sleep },
  );
  await new Promise(setImmediate);
  expect(sleep.mock.calls).toEqual([[25], [25]]);
  expect(getTransaction).toHaveBeenCalledTimes(1);
  expect(attempt).toHaveBeenCalledTimes(1);
  finish();
  expect(await operation).toEqual({ type: "ok", value: "ok" });
  expect(getTransaction).toHaveBeenCalledTimes(2);
  expect(beforeCommit).toHaveBeenCalledTimes(1);
  expect(afterCommit).toHaveBeenCalledTimes(1);
});

test("a valid first long hint stops after cleanup without spending another attempt", async () => {
  const clock = virtualClock();
  const { database, getTransaction, transactions } = fakeDatabase();
  const cause = Object.assign(aborted(), {
    metadata: {
      get: () => [Buffer.from("0a02083d", "hex"), Buffer.from("0a00", "hex")],
    },
  });
  const result = await runSpannerReadWriteTransaction(
    database,
    5,
    async () => {
      throw cause;
    },
    undefined,
    clock,
  );
  expect(result).toMatchObject({
    type: "err",
    error: {
      type: "storage-error",
      cause,
      message: expect.stringContaining("server retry delay"),
    },
  });
  expect(getTransaction).toHaveBeenCalledTimes(1);
  expect(transactions[0].rollback).toHaveBeenCalledTimes(1);
  expect(transactions[0].end).toHaveBeenCalledTimes(1);
  expect(clock.random).not.toHaveBeenCalled();
  expect(clock.sleep).not.toHaveBeenCalled();
});
