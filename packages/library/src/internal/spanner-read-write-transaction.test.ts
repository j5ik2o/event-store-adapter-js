import { runSpannerReadWriteTransaction } from "./spanner-read-write-transaction";

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
