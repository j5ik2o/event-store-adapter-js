import type { AggregateId } from "../aggregate-id";
import { spannerAggregateKey } from "./spanner-aggregate-key";
import { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";
import { createSpannerGetEvents } from "./spanner-get-events";
import { createSpannerGetLatestSnapshot } from "./spanner-get-latest-snapshot";
import {
  createSpannerPersistEvent,
  createSpannerPersistEventAndSnapshot,
} from "./spanner-persist-event";
import { retainSpannerSnapshots } from "./spanner-snapshot-retention";
import { spannerTableNames } from "./spanner-table-names";

type Rows = Readonly<Record<string, readonly Record<string, unknown>[]>>;

const id: AggregateId = { typeName: "Order", value: "1" };
const int = (value: number) => ({ value: String(value) });
const head = (overrides: Record<string, unknown> = {}) => ({
  type_name: "Order",
  seq_nr: int(2),
  event_occurred_at_ns: int(1),
  event_manifest: "m",
  event_payload: Buffer.from("{}"),
  ...overrides,
});
const journal = (seqNr: number, overrides: Record<string, unknown> = {}) => ({
  seq_nr: int(seqNr),
  occurred_at_ns: int(1_000_000),
  manifest: "m",
  payload: Buffer.from("{}"),
  ...overrides,
});
const current = (overrides: Record<string, unknown> = {}) => ({
  seq_nr: int(2),
  manifest: "m",
  payload: Buffer.from("{}"),
  ...overrides,
});

// SQL の対象テーブルで、返す行を選ぶ偽の Database
function fakeDatabase(rows: Rows) {
  const select = (sql: string) =>
    Object.entries(rows).find(([table]) =>
      sql.includes(`esa_${table}\``),
    )?.[1] ?? [];
  const end = jest.fn();
  const getSnapshot = jest.fn(async (_options?: unknown) => [
    { run: async ({ sql }: { sql: string }) => [select(sql)], end },
  ]);
  return { end, getSnapshot, database: { getSnapshot } as never };
}

function settingsOf(database: never, extra: Record<string, unknown> = {}) {
  const settings = validateSpannerEventStoreInput({
    database,
    tablePrefix: "esa",
    ...extra,
  });
  if (settings.type === "err") throw new Error(settings.error.message);
  return settings.value;
}

const storageError = { type: "err", error: { type: "storage-error" } };

describe("getEventsByIdSinceSeqNr with corrupt or unexpected rows", () => {
  const read = async (rows: Rows) => {
    const { database, end, getSnapshot } = fakeDatabase(rows);
    const result = await createSpannerGetEvents(settingsOf(database))(id, 1);
    expect(end).toHaveBeenCalledTimes(1);
    // SPN-10: strong の読み取り専用トランザクション
    expect(getSnapshot).toHaveBeenCalledWith({ strong: true });
    return result;
  };

  test("a head with an invalid seq_nr is a storage error", async () => {
    expect(await read({ head: [head({ seq_nr: int(0) })] })).toMatchObject(
      storageError,
    );
  });

  test.each([
    ["a seq_nr that is not the expected one", journal(2)],
    ["an invalid occurred_at_ns", journal(1, { occurred_at_ns: "x" })],
    ["a manifest that is not a string", journal(1, { manifest: null })],
    ["a payload that is not bytes", journal(1, { payload: "{}" })],
  ])("a journal row with %s is a storage error", async (_, row) => {
    expect(
      await read({ head: [head({ seq_nr: int(1) })], journal: [row] }),
    ).toMatchObject(storageError);
  });

  test("a journal range shorter than the head is a storage error", async () => {
    expect(await read({ head: [head()], journal: [journal(1)] })).toMatchObject(
      storageError,
    );
  });

  test("floors a negative occurred_at_ns toward negative infinity", async () => {
    const result = await read({
      head: [head({ seq_nr: int(1) })],
      journal: [journal(1, { occurred_at_ns: int(-1) })],
    });
    expect(result).toMatchObject({
      type: "ok",
      value: [{ occurredAt: new Date(-1) }],
    });
  });
});

describe("getLatestSnapshotById with corrupt or unexpected rows", () => {
  const read = async (rows: Rows) => {
    const { database, end, getSnapshot } = fakeDatabase(rows);
    const result = await createSpannerGetLatestSnapshot(settingsOf(database))(
      id,
    );
    expect(end).toHaveBeenCalledTimes(1);
    // SPN-9: strong の読み取り専用トランザクション
    expect(getSnapshot).toHaveBeenCalledWith({ strong: true });
    return result;
  };

  test.each([
    ["a different type_name", head({ type_name: "Other" })],
    ["an invalid seq_nr", head({ seq_nr: int(0) })],
    ["an invalid event_occurred_at_ns", head({ event_occurred_at_ns: "x" })],
    ["an event_manifest that is not a string", head({ event_manifest: 1 })],
    ["an event_payload that is not bytes", head({ event_payload: "{}" })],
  ])("a head with %s is a storage error", async (_, row) => {
    expect(await read({ head: [row] })).toMatchObject(storageError);
  });

  test.each([
    ["a manifest that is not a string", current({ manifest: 1 })],
    ["a payload that is not bytes", current({ payload: "{}" })],
    ["a seq_nr above the head", current({ seq_nr: int(3) })],
  ])("a snapshot with %s is a storage error", async (_, row) => {
    expect(
      await read({ head: [head()], snapshot_current: [row] }),
    ).toMatchObject(storageError);
  });
});

describe("persistEvent with unexpected values", () => {
  const event = {
    aggregateId: id,
    seqNr: 1,
    occurredAt: new Date(0),
    manifest: "m",
    payload: {},
  };

  test("a serializer that does not return bytes is a serialization error", async () => {
    const persist = createSpannerPersistEvent(
      settingsOf({} as never, {
        eventSerializer: { serialize: () => "x", deserialize: () => ({}) },
      }),
    );
    expect(await persist(event)).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "serialize" },
    });
  });

  test("a stored head with an invalid seq_nr is a storage error and nothing is committed", async () => {
    const commit = jest.fn();
    const rollback = jest.fn();
    const database = {
      getTransaction: async () => [
        {
          run: async () => [[{ seq_nr: int(0) }]],
          commit,
          rollback,
          end: jest.fn(),
        },
      ],
    } as never;
    const persist = createSpannerPersistEvent(settingsOf(database));
    expect(await persist(event)).toMatchObject(storageError);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});

test("a stored history row with an invalid seq_nr fails the retention transaction", async () => {
  const names = spannerTableNames("esa");
  if (names.type === "err") throw new Error("names");
  const commit = jest.fn();
  const database = {
    getTransaction: async () => [
      {
        run: async () => [[{ seq_nr: int(0) }]],
        commit,
        rollback: jest.fn(),
        end: jest.fn(),
      },
    ],
  } as never;
  const result = await retainSpannerSnapshots(
    {
      database,
      tables: names.value,
      transactionRetryLimit: 0,
      retention: { count: 1, mode: { type: "delete" } },
    },
    spannerAggregateKey(id),
  );
  expect(result).toMatchObject(storageError);
  expect(commit).not.toHaveBeenCalled();
});

describe("input validation before touching the database", () => {
  const untouched = {
    getSnapshot: () => {
      throw new Error("must not read");
    },
    getTransaction: () => {
      throw new Error("must not write");
    },
  } as never;
  const settings = () => settingsOf(untouched);

  test("reads reject an invalid aggregate id and an invalid seqNr", async () => {
    const bad = { typeName: "Or-der", value: "1" };
    expect(await createSpannerGetEvents(settings())(bad, 1)).toMatchObject({
      type: "err",
      error: { type: "contract-violation" },
    });
    expect(await createSpannerGetEvents(settings())(id, -1)).toMatchObject({
      type: "err",
    });
    expect(await createSpannerGetLatestSnapshot(settings())(bad)).toMatchObject(
      { type: "err", error: { type: "contract-violation" } },
    );
  });

  test("appends reject an invalid event and a mismatched snapshot", async () => {
    const event = {
      aggregateId: { typeName: "Or-der", value: "1" },
      seqNr: 1,
      occurredAt: new Date(0),
      manifest: "m",
      payload: {},
    };
    expect(await createSpannerPersistEvent(settings())(event)).toMatchObject({
      type: "err",
      error: { type: "contract-violation" },
    });
    expect(
      await createSpannerPersistEventAndSnapshot(settings())(event, {
        seqNr: 2,
        manifest: "m",
        aggregate: {},
      }),
    ).toMatchObject({ type: "err", error: { type: "contract-violation" } });
  });
});
