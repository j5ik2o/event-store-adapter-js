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
