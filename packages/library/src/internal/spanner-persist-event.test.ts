import { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";
import {
  createSpannerPersistEvent,
  createSpannerPersistEventAndSnapshot,
} from "./spanner-persist-event";

const event = {
  aggregateId: { typeName: "Order", value: "1" },
  seqNr: 1,
  occurredAt: new Date(0),
  manifest: "m",
  payload: {},
};

function settingsOf(database: never, extra: Record<string, unknown> = {}) {
  const settings = validateSpannerEventStoreInput({
    database,
    tablePrefix: "esa",
    ...extra,
  });
  if (settings.type === "err") throw new Error(settings.error.message);
  return settings.value;
}

const transaction = () => ({
  run: jest.fn(async () => [[]]),
  batchUpdate: jest.fn(async () => [[1, 1, 1, 1], {}]),
  commit: jest.fn(async () => undefined),
  rollback: jest.fn(async () => undefined),
  end: jest.fn(),
});

test("an append whose transaction cannot be acquired returns a storage error instead of rejecting", async () => {
  const database = {
    getTransaction: async () => {
      throw new Error("session unavailable");
    },
  } as never;
  await expect(
    createSpannerPersistEvent(settingsOf(database))(event),
  ).resolves.toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
});

test("when the retention transaction cannot be acquired after a committed append, the append stays ok and the failure is notified once", async () => {
  const appended = transaction();
  let acquired = 0;
  const database = {
    getTransaction: async () => {
      acquired += 1;
      if (acquired === 1) return [appended];
      throw new Error("session unavailable");
    },
  } as never;
  const onRetentionFailure = jest.fn();
  const logger = { ...console, error: jest.fn() };

  const result = await createSpannerPersistEventAndSnapshot(
    settingsOf(database, {
      retention: { count: 1 },
      onRetentionFailure,
      logger,
    }),
  )(event, { seqNr: 1, manifest: "s", aggregate: {} });

  expect(result).toEqual({ type: "ok", value: undefined });
  expect(appended.commit).toHaveBeenCalledTimes(1);
  expect(acquired).toBe(2);
  expect(onRetentionFailure).toHaveBeenCalledTimes(1);
  expect(onRetentionFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "retention-failure",
      aggregateId: "Order-1",
    }),
  );
});

test.each([false, true])(
  "ABORTED append rechecks head and preserves envelope, concurrent head=%s",
  async (advanced) => {
    jest.useFakeTimers();
    try {
      const first = transaction();
      const second = transaction();
      first.commit.mockRejectedValue(
        Object.assign(Error("aborted"), { code: 10 }),
      );
      if (advanced) second.run.mockResolvedValue([[{ seq_nr: "1" }]] as never);
      const getTransaction = jest
        .fn()
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second]);
      const beforeCommit = jest.fn();
      const afterCommit = jest.fn();
      const input = { ...event, payload: { immutable: true } };
      const operation = createSpannerPersistEvent(
        settingsOf({ getTransaction } as never),
        { beforeCommit, afterCommit },
      )(input);
      await jest.runAllTimersAsync();
      const result = await operation;
      expect(first.run).toHaveBeenCalledTimes(1);
      expect(second.run).toHaveBeenCalledTimes(1);
      expect(getTransaction).toHaveBeenCalledTimes(2);
      expect(first.rollback).toHaveBeenCalledTimes(1);
      expect(first.end).toHaveBeenCalledTimes(1);
      expect(second.end).toHaveBeenCalledTimes(1);
      expect(input).toEqual({ ...event, payload: { immutable: true } });
      if (advanced) {
        expect(result).toMatchObject({
          type: "err",
          error: { type: "optimistic-lock-conflict" },
        });
        expect(second.batchUpdate).not.toHaveBeenCalled();
        expect(second.commit).not.toHaveBeenCalled();
        expect(afterCommit).not.toHaveBeenCalled();
      } else {
        expect(result.type).toBe("ok");
        expect(second.batchUpdate.mock.calls).toEqual(
          first.batchUpdate.mock.calls,
        );
        expect(beforeCommit).toHaveBeenCalledTimes(2);
        expect(afterCommit).toHaveBeenCalledTimes(1);
      }
    } finally {
      jest.useRealTimers();
    }
  },
);
