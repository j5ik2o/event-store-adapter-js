import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContractRule } from "../contract-rule";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import type { EventStoreError } from "../event-store-error";
import type { Logger } from "../logger";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import { MemoryStorage } from "../memory-storage";
import type { Result } from "../result";
import type { RetentionFailure } from "../retention-failure";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { createMemoryEventStoreInternal } from "./memory-event-store";
import type { MemoryRetentionHooks } from "./memory-retention-hooks";
import { inspectMemoryStorageRecords } from "./memory-storage-records";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message);
  return result.value;
}

const aggregateId = { typeName: "Order", value: "9" };
const eventOf = (seqNr: number): EventEnvelope => ({
  aggregateId,
  seqNr,
  occurredAt: new Date("2026-10-09T00:00:00.123Z"),
  manifest: "event/v1",
  payload: { seqNr },
});
const snapshotOf = (seqNr: number): SnapshotEnvelope => ({
  seqNr,
  manifest: "snapshot/v1",
  aggregate: { seqNr },
});

function loggerOf(error: Logger["error"]): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error };
}

async function recordOf(storage: MemoryStorage) {
  const record = unwrap(await inspectMemoryStorageRecords(storage)).records.get(
    "Order-9",
  );
  if (record === undefined) throw new Error("expected real committed record");
  return record;
}

describe("memory retention through the internal factory", () => {
  test.each([undefined, 1, 3])(
    "retains only the newest history after both append operations (count=%p)",
    async (count) => {
      const storage = unwrap(
        MemoryStorage.create(
          count === undefined ? undefined : { retention: { count } },
        ),
      );
      const beforeDelete = jest.fn();
      const listHistory = jest.fn(
        (_aid: string, seqNrs: readonly number[]) => seqNrs,
      );
      const store = unwrap(
        createMemoryEventStoreInternal(
          { storage },
          { listHistory, beforeDelete },
        ),
      );

      for (const seqNr of [1, 2, 3, 4]) {
        unwrap(
          await store.persistEventAndSnapshot(
            eventOf(seqNr),
            snapshotOf(seqNr),
          ),
        );
        expect(
          (await recordOf(storage)).history.map((snapshot) => snapshot.seqNr),
        ).toEqual(
          count === undefined ? [] : [1, 2, 3, 4].slice(0, seqNr).slice(-count),
        );
      }
      unwrap(await store.persistEvent(eventOf(5)));

      const record = await recordOf(storage);
      expect(record.history.map((snapshot) => snapshot.seqNr)).toEqual(
        count === undefined ? [] : [1, 2, 3, 4].slice(-count),
      );
      expect(record.head.seqNr).toBe(5);
      expect(record.snapshot?.seqNr).toBe(4);
      expect(unwrap(await store.getLatestSnapshotById(aggregateId))).toEqual({
        headSeqNr: 5,
        snapshot: snapshotOf(4),
      });
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(aggregateId, 0)),
      ).toEqual([1, 2, 3, 4, 5].map(eventOf));
      expect(beforeDelete.mock.calls).toEqual(
        count === undefined
          ? []
          : [1, 2, 3, 4].slice(0, -count).map((seqNr) => ["Order-9", seqNr]),
      );
      expect(listHistory).toHaveBeenCalledTimes(count === undefined ? 0 : 5);
    },
  );

  test("adds just-written history and removes duplicate candidates supplied by the enumeration hook", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const beforeDelete = jest.fn();
    const store = unwrap(
      createMemoryEventStoreInternal(
        { storage },
        {
          listHistory: (_aid, seqNrs) =>
            seqNrs.slice(0, -1).flatMap((seqNr) => [seqNr, seqNr]),
          beforeDelete,
        },
      ),
    );

    for (const seqNr of [1, 2, 3]) {
      unwrap(
        await store.persistEventAndSnapshot(eventOf(seqNr), snapshotOf(seqNr)),
      );
      expect(
        (await recordOf(storage)).history.map((snapshot) => snapshot.seqNr),
      ).toEqual([seqNr]);
    }

    expect(beforeDelete.mock.calls).toEqual([
      ["Order-9", 1],
      ["Order-9", 2],
    ]);
  });

  test.each(["query", "delete"] as const)(
    "preserves success and reselects leftovers after a %s failure",
    async (phase) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      const cause = new Error("controlled retention failure");
      const onRetentionFailure = jest.fn();
      const error = jest.fn();
      const listHistory = jest.fn((_aid: string, seqNrs: readonly number[]) => {
        if (phase === "query" && seqNrs.length === 2) throw cause;
        return seqNrs;
      });
      const beforeDelete = jest.fn().mockImplementationOnce(() => {
        if (phase === "delete") throw cause;
      });
      const store = unwrap(
        createMemoryEventStoreInternal(
          { storage, logger: loggerOf(error), onRetentionFailure },
          { listHistory, beforeDelete },
        ),
      );
      unwrap(await store.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));

      expect(
        await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)),
      ).toEqual({ type: "ok", value: undefined });
      const failed = await recordOf(storage);
      expect(failed.history.map((snapshot) => snapshot.seqNr)).toEqual([1, 2]);
      expect(failed.head.seqNr).toBe(2);
      expect(unwrap(await store.getLatestSnapshotById(aggregateId))).toEqual({
        headSeqNr: 2,
        snapshot: snapshotOf(2),
      });
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(aggregateId, 0)),
      ).toEqual([eventOf(1), eventOf(2)]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(onRetentionFailure).toHaveBeenCalledTimes(1);
      const failure = onRetentionFailure.mock.calls[0][0];
      expect(failure).toEqual({
        kind: "retention-failure",
        aggregateId: "Order-9",
        cause,
      });
      expect(failure.cause).toBe(cause);

      // 同じ保存先へsnapshot付き追記を行い、失敗前に作られた履歴も再処理する。
      unwrap(await store.persistEventAndSnapshot(eventOf(3), snapshotOf(3)));
      const recovered = await recordOf(storage);
      expect(recovered.history.map((snapshot) => snapshot.seqNr)).toEqual([3]);
      expect(recovered.events.map((event) => event.seqNr)).toEqual([1, 2, 3]);
      expect(listHistory.mock.calls.map((call) => [...call[1]])).toEqual([
        [1],
        [1, 2],
        [1, 2, 3],
      ]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(onRetentionFailure).toHaveBeenCalledTimes(1);
    },
  );

  test("event-only retry keeps successful deletions and removes remaining history in oldest-first order", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const queryCause = new Error("accumulate real history");
    const deleteCause = new Error("second deletion fails");
    let collecting = true;
    let deletionFailed = false;
    const error = jest.fn();
    const onRetentionFailure = jest.fn();
    const listHistory = jest.fn((_aid: string, seqNrs: readonly number[]) => {
      if (collecting && seqNrs.length > 1) throw queryCause;
      return seqNrs;
    });
    const beforeDelete = jest.fn((_aid: string, seqNr: number) => {
      if (seqNr === 2 && !deletionFailed) {
        deletionFailed = true;
        throw deleteCause;
      }
    });
    const store = unwrap(
      createMemoryEventStoreInternal(
        { storage, logger: loggerOf(error), onRetentionFailure },
        { listHistory, beforeDelete },
      ),
    );
    for (const seqNr of [1, 2, 3])
      unwrap(
        await store.persistEventAndSnapshot(eventOf(seqNr), snapshotOf(seqNr)),
      );
    expect(
      (await recordOf(storage)).history.map((snapshot) => snapshot.seqNr),
    ).toEqual([1, 2, 3]);
    collecting = false;

    unwrap(await store.persistEventAndSnapshot(eventOf(4), snapshotOf(4)));
    expect(
      (await recordOf(storage)).history.map((snapshot) => snapshot.seqNr),
    ).toEqual([2, 3, 4]);
    expect(onRetentionFailure.mock.calls[2][0].cause).toBe(deleteCause);
    unwrap(await store.persistEvent(eventOf(5)));

    const record = await recordOf(storage);
    expect(record.history.map((snapshot) => snapshot.seqNr)).toEqual([4]);
    expect(record.head.seqNr).toBe(5);
    expect(record.snapshot?.seqNr).toBe(4);
    expect(record.events.map((event) => event.seqNr)).toEqual([1, 2, 3, 4, 5]);
    expect(beforeDelete.mock.calls).toEqual([
      ["Order-9", 1],
      ["Order-9", 2],
      ["Order-9", 2],
      ["Order-9", 3],
    ]);
    expect(listHistory.mock.calls[4][1]).toEqual([2, 3, 4]);
    expect(onRetentionFailure).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(3);
  });

  test("shared users apply immutable storage settings and isolate another aggregate's history", async () => {
    const input = { retention: { count: 2 } };
    const storage = unwrap(MemoryStorage.create(input));
    const first = unwrap(createMemoryEventStoreInternal({ storage }));
    const second = unwrap(createMemoryEventStoreInternal({ storage }));
    input.retention.count = 1;
    const otherId = { typeName: "Order", value: "90" };
    unwrap(
      await second.persistEventAndSnapshot(
        { ...eventOf(1), aggregateId: otherId },
        snapshotOf(1),
      ),
    );
    const otherBefore = unwrap(
      await inspectMemoryStorageRecords(storage),
    ).records.get("Order-90");

    unwrap(await first.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));
    unwrap(await second.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));
    unwrap(await first.persistEventAndSnapshot(eventOf(3), snapshotOf(3)));

    expect(
      (await recordOf(storage)).history.map((snapshot) => snapshot.seqNr),
    ).toEqual([2, 3]);
    expect(
      unwrap(await inspectMemoryStorageRecords(storage)).configuration.retention
        ?.count,
    ).toBe(2);
    expect(
      unwrap(await inspectMemoryStorageRecords(storage)).records.get(
        "Order-90",
      ),
    ).toEqual(otherBefore);
    expect(unwrap(await second.getLatestSnapshotById(aggregateId))).toEqual({
      headSeqNr: 3,
      snapshot: snapshotOf(3),
    });
  });

  test("holds the shared queue until retention finishes while independent storage and invalid inputs progress", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = unwrap(
      createMemoryEventStoreInternal(
        { storage },
        {
          beforeDelete: () => {
            entered.resolve();
            return release.promise;
          },
        },
      ),
    );
    const second = unwrap(createMemoryEventStoreInternal({ storage }));
    const independent = unwrap(
      createMemoryEventStoreInternal({
        storage: unwrap(MemoryStorage.create({ retention: { count: 1 } })),
      }),
    );
    unwrap(await first.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));
    const writing = first.persistEventAndSnapshot(eventOf(2), snapshotOf(2));
    await entered.promise;
    const completed = jest.fn();
    const reading = second.getLatestSnapshotById(aggregateId).then((result) => {
      completed();
      return result;
    });
    const inspecting = inspectMemoryStorageRecords(storage).then((result) => {
      completed();
      return result;
    });
    try {
      unwrap(
        await independent.persistEventAndSnapshot(eventOf(1), snapshotOf(1)),
      );
      expect(
        unwrap(await independent.getLatestSnapshotById(aggregateId)),
      ).toEqual({ headSeqNr: 1, snapshot: snapshotOf(1) });
      expect(await second.persistEvent(eventOf(0))).toMatchObject({
        type: "err",
        error: { rule: "W-6" },
      });
      expect(completed).not.toHaveBeenCalled();
      release.resolve();
      unwrap(await writing);
      expect(unwrap(await reading)).toEqual({
        headSeqNr: 2,
        snapshot: snapshotOf(2),
      });
      expect(
        unwrap(await inspecting)
          .records.get("Order-9")
          ?.history.map((snapshot) => snapshot.seqNr),
      ).toEqual([2]);
    } finally {
      release.resolve();
      await Promise.allSettled([writing, reading, inspecting]);
    }
  });

  test("notifies only the writing user and lets another shared user retry through an event-only append", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const cause = new Error("first user's retention fails");
    const firstNotification = jest.fn();
    const secondNotification = jest.fn();
    const firstError = jest.fn();
    const secondError = jest.fn();
    const first = unwrap(
      createMemoryEventStoreInternal(
        {
          storage,
          logger: loggerOf(firstError),
          onRetentionFailure: firstNotification,
        },
        {
          beforeDelete: () => {
            throw cause;
          },
        },
      ),
    );
    const second = unwrap(
      createMemoryEventStoreInternal({
        storage,
        logger: loggerOf(secondError),
        onRetentionFailure: secondNotification,
      }),
    );
    unwrap(await second.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));

    unwrap(await first.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));
    expect(
      (await recordOf(storage)).history.map((snapshot) => snapshot.seqNr),
    ).toEqual([1, 2]);
    unwrap(await second.persistEvent(eventOf(3)));

    const record = await recordOf(storage);
    expect(record.history.map((snapshot) => snapshot.seqNr)).toEqual([2]);
    expect(record.head.seqNr).toBe(3);
    expect(record.snapshot?.seqNr).toBe(2);
    expect(firstNotification).toHaveBeenCalledTimes(1);
    expect(firstError).toHaveBeenCalledTimes(1);
    expect(firstNotification.mock.calls[0][0].cause).toBe(cause);
    expect(secondNotification).not.toHaveBeenCalled();
    expect(secondError).not.toHaveBeenCalled();
  });

  test("notifies logger and callback outside the queue and allows same-storage reentry", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const cause = new Error("retention deletion fails once");
    const beforeDelete = jest.fn().mockImplementationOnce(() => {
      throw cause;
    });
    let store: EventStore;
    const error = jest.fn(async () => {
      expect(unwrap(await store.getLatestSnapshotById(aggregateId))).toEqual({
        headSeqNr: 2,
        snapshot: snapshotOf(2),
      });
    });
    const onRetentionFailure = jest.fn(async () => {
      unwrap(await store.persistEvent(eventOf(3)));
    });
    store = unwrap(
      createMemoryEventStoreInternal(
        { storage, logger: loggerOf(error), onRetentionFailure },
        { beforeDelete },
      ),
    );
    unwrap(await store.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));

    expect(
      await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)),
    ).toEqual({ type: "ok", value: undefined });

    expect(error).toHaveBeenCalledTimes(1);
    expect(onRetentionFailure).toHaveBeenCalledTimes(1);
    const record = await recordOf(storage);
    expect(record.head.seqNr).toBe(3);
    expect(record.snapshot?.seqNr).toBe(2);
    expect(record.history.map((snapshot) => snapshot.seqNr)).toEqual([2]);
  });

  test.each([false, true])(
    "logs a callback failure without changing success (async=%p)",
    async (asyncFailure) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      const cause = new Error("retention failed");
      const callbackCause = new Error("callback failed");
      const error = jest.fn();
      const onRetentionFailure = jest.fn(() => {
        if (asyncFailure) return Promise.reject(callbackCause);
        throw callbackCause;
      });
      const store = unwrap(
        createMemoryEventStoreInternal(
          { storage, logger: loggerOf(error), onRetentionFailure },
          {
            beforeDelete: () => {
              throw cause;
            },
          },
        ),
      );
      unwrap(await store.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));

      unwrap(await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));

      expect(onRetentionFailure).toHaveBeenCalledTimes(1);
      expect(error.mock.calls).toEqual([
        [{ kind: "retention-failure", aggregateId: "Order-9", cause }],
        [expect.any(String), callbackCause],
      ]);
      expect((await recordOf(storage)).head.seqNr).toBe(2);
    },
  );

  test("logs logger's own failure and still calls the additional callback", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const cause = new Error("retention failed");
    const loggerCause = new Error("logger failed once");
    const error = jest.fn().mockImplementationOnce(() => {
      throw loggerCause;
    });
    const onRetentionFailure = jest.fn();
    const store = unwrap(
      createMemoryEventStoreInternal(
        { storage, logger: loggerOf(error), onRetentionFailure },
        {
          beforeDelete: () => {
            throw cause;
          },
        },
      ),
    );
    unwrap(await store.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));

    unwrap(await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));

    expect(error.mock.calls).toEqual([
      [{ kind: "retention-failure", aggregateId: "Order-9", cause }],
      [expect.any(String), loggerCause],
    ]);
    expect(onRetentionFailure).toHaveBeenCalledTimes(1);
    expect((await recordOf(storage)).head.seqNr).toBe(2);
  });

  test.each([false, true])(
    "keeps success if both notifications throw, including fallback logging (console throws=%p)",
    async (consoleThrows) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      const cause = new Error("retention failed");
      const loggerCause = new Error("logger unavailable");
      const callbackCause = new Error("callback unavailable");
      const error = jest.fn<
        ReturnType<Logger["error"]>,
        Parameters<Logger["error"]>
      >(() => {
        throw loggerCause;
      });
      const onRetentionFailure = jest.fn(() => {
        throw callbackCause;
      });
      const fallback = jest.spyOn(console, "error").mockImplementation(() => {
        if (consoleThrows) throw new Error("console unavailable");
      });
      try {
        const store = unwrap(
          createMemoryEventStoreInternal(
            { storage, logger: loggerOf(error), onRetentionFailure },
            {
              beforeDelete: () => {
                throw cause;
              },
            },
          ),
        );
        unwrap(await store.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));

        unwrap(await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));

        expect(
          error.mock.calls.filter(
            (call) => call[0]?.kind === "retention-failure",
          ),
        ).toHaveLength(1);
        expect(onRetentionFailure).toHaveBeenCalledTimes(1);
        expect(fallback).toHaveBeenCalledTimes(2);
        expect(fallback.mock.calls[0].slice(1)).toEqual([
          loggerCause,
          loggerCause,
        ]);
        expect(fallback.mock.calls[1].slice(1)).toEqual([
          callbackCause,
          loggerCause,
        ]);
        expect((await recordOf(storage)).head.seqNr).toBe(2);
      } finally {
        fallback.mockRestore();
      }
    },
  );

  test("uses the mandatory default logger and preserves an undefined thrown cause", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const store = unwrap(
        createMemoryEventStoreInternal(
          { storage },
          {
            beforeDelete: () => {
              throw undefined;
            },
          },
        ),
      );
      unwrap(await store.persistEventAndSnapshot(eventOf(1), snapshotOf(1)));

      unwrap(await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));

      expect(error.mock.calls).toEqual([
        [
          {
            kind: "retention-failure",
            aggregateId: "Order-9",
            cause: undefined,
          },
        ],
      ]);
      expect(
        (await recordOf(storage)).history.map((snapshot) => snapshot.seqNr),
      ).toEqual([1, 2]);
    } finally {
      error.mockRestore();
    }
  });

  test.each([
    [{ onRetentionFailure: null }, "onRetentionFailure"],
    [{ logger: {} }, "logger"],
    [{ eventSerializer: {}, onRetentionFailure: null }, "eventSerializer"],
    [{ snapshotSerializer: {}, logger: {} }, "snapshotSerializer"],
  ])("uses existing input validation for %p", (input, fieldName) => {
    expect(
      createMemoryEventStoreInternal(
        input as MemoryEventStoreInput<unknown, unknown>,
      ),
    ).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName },
    });
  });
});

type FixtureId = { type_name: string; value: string };
type Scenario = {
  id: string;
  store: { retention_count: number | null; retention_mode: "delete" };
  fixtures: {
    events: Record<
      string,
      {
        aggregate_id: FixtureId;
        seq_nr: number;
        occurred_at: string;
        manifest?: string;
        payload: unknown;
      }
    >;
    snapshots: Record<
      string,
      { seq_nr: number; manifest?: string; aggregate: unknown }
    >;
  };
  steps: {
    op: keyof EventStore;
    arguments: {
      event?: string;
      snapshot?: string;
      aggregate_id?: FixtureId;
      seq_nr?: number;
    };
    expect: {
      result?: "success" | "none" | "snapshot" | "events";
      head_seq_nr?: number;
      snapshot?: string;
      events?: string[];
      error?: {
        category: "contract-violation";
        rule: ContractRule;
        message: { must_contain: string[]; must_not_contain: string[] };
      };
    };
    observe?: {
      history?: { active: number[]; marked: unknown[]; absent: number[] };
      notifications?: string[];
    };
  }[];
  faults?: {
    operation: number;
    phase: "retention-query" | "retention-delete";
    kind: "sdk-response" | "storage-error";
    details: { history_pages?: number[][]; message?: string };
    repeat: { mode: "count"; count: number };
  }[];
};

const conformanceRoot = resolve(
  __dirname,
  "../../../../conformance/scenarios/core",
);
const distributed: Scenario[] = [
  "retention-errors.json",
  "write-read.json",
].flatMap(
  (file) =>
    JSON.parse(readFileSync(resolve(conformanceRoot, file), "utf8")).cases,
);
const selectedIds = [
  "core-retention-default-current-only",
  "core-retention-delete-1",
  "core-retention-delete-2",
  "core-retention-failure-after-commit",
  "core-retention-query-failure",
  "core-zero-event",
  "core-snapshot-mismatch-2",
];

function fixtureEvent(scenario: Scenario, key: string): EventEnvelope {
  const fixture = scenario.fixtures.events[key];
  return {
    aggregateId: {
      typeName: fixture.aggregate_id.type_name,
      value: fixture.aggregate_id.value,
    },
    seqNr: fixture.seq_nr,
    occurredAt: new Date(fixture.occurred_at),
    manifest: fixture.manifest ?? "",
    payload: fixture.payload,
  };
}

function fixtureSnapshot(scenario: Scenario, key: string): SnapshotEnvelope {
  const fixture = scenario.fixtures.snapshots[key];
  return {
    seqNr: fixture.seq_nr,
    manifest: fixture.manifest ?? "",
    aggregate: fixture.aggregate,
  };
}

// 今回の7ケースだけを実操作へ対応付ける。全適合実行器のbindingには接続しない。
describe("distributed cases at the memory retention boundary", () => {
  test.each(selectedIds)(
    "%s compares expect/observe/error.rule with real records",
    async (caseId) => {
      const scenario = distributed.find((scenario) => scenario.id === caseId);
      if (scenario === undefined)
        throw new Error(`missing distributed case ${caseId}`);
      const count = scenario.store.retention_count;
      const storage = unwrap(
        MemoryStorage.create(
          count === null
            ? undefined
            : {
                retention: {
                  count,
                  mode: { type: scenario.store.retention_mode },
                },
              },
        ),
      );
      let operation = 0;
      const faults = scenario.faults ?? [];
      const applications = faults.map(() => 0);
      function consumeFault(phase: "retention-query" | "retention-delete") {
        const index = faults.findIndex(
          (fault, index) =>
            fault.operation === operation &&
            fault.phase === phase &&
            applications[index] < fault.repeat.count,
        );
        if (index === -1) return undefined;
        applications[index] += 1;
        return faults[index];
      }
      const hooks: MemoryRetentionHooks = {
        listHistory: (_aid, seqNrs) => {
          const fault = consumeFault("retention-query");
          if (fault === undefined) return seqNrs;
          if (fault.kind === "storage-error")
            throw new Error(fault.details.message);
          if (fault.details.history_pages === undefined)
            throw new Error("missing history pages");
          return fault.details.history_pages.flat();
        },
        beforeDelete: () => {
          const fault = consumeFault("retention-delete");
          if (fault !== undefined) throw new Error(fault.details.message);
        },
      };
      const onRetentionFailure = jest.fn<void, [RetentionFailure]>();
      const error = jest.fn();
      const store = unwrap(
        createMemoryEventStoreInternal(
          { storage, logger: loggerOf(error), onRetentionFailure },
          hooks,
        ),
      );
      const observations = [];
      for (const step of scenario.steps) {
        operation += 1;
        const before = unwrap(
          await inspectMemoryStorageRecords(storage),
        ).records;
        const notificationStart = onRetentionFailure.mock.calls.length;
        const loggerStart = error.mock.calls.length;
        const args = step.arguments;
        let result: Result<unknown, EventStoreError>;
        switch (step.op) {
          case "persistEvent":
            if (args.event === undefined)
              throw new Error("missing event reference");
            result = await store.persistEvent(
              fixtureEvent(scenario, args.event),
            );
            break;
          case "persistEventAndSnapshot":
            if (args.event === undefined || args.snapshot === undefined)
              throw new Error("missing pair references");
            result = await store.persistEventAndSnapshot(
              fixtureEvent(scenario, args.event),
              fixtureSnapshot(scenario, args.snapshot),
            );
            break;
          case "getLatestSnapshotById":
            if (args.aggregate_id === undefined)
              throw new Error("missing aggregate ID");
            result = await store.getLatestSnapshotById({
              typeName: args.aggregate_id.type_name,
              value: args.aggregate_id.value,
            });
            break;
          case "getEventsByIdSinceSeqNr":
            if (args.aggregate_id === undefined || args.seq_nr === undefined)
              throw new Error("missing read arguments");
            result = await store.getEventsByIdSinceSeqNr(
              {
                typeName: args.aggregate_id.type_name,
                value: args.aggregate_id.value,
              },
              args.seq_nr,
            );
            break;
        }
        const records = unwrap(
          await inspectMemoryStorageRecords(storage),
        ).records;
        const expected = step.expect;
        if (expected.error !== undefined) {
          expect(result).toMatchObject({
            type: "err",
            error: { type: expected.error.category, rule: expected.error.rule },
          });
          if (result.type !== "err")
            throw new Error("expected contract violation");
          for (const text of expected.error.message.must_contain)
            expect(result.error.message).toContain(text);
          for (const text of expected.error.message.must_not_contain)
            expect(result.error.message).not.toContain(text);
          expect(records).toEqual(before);
        } else {
          const value = unwrap(result);
          switch (expected.result) {
            case "success":
              expect(value).toBeUndefined();
              break;
            case "none":
              expect(value).toBeUndefined();
              break;
            case "snapshot":
              if (expected.snapshot === undefined)
                throw new Error("missing expected snapshot reference");
              expect(value).toEqual({
                headSeqNr: expected.head_seq_nr,
                snapshot: fixtureSnapshot(scenario, expected.snapshot),
              });
              break;
            case "events":
              if (expected.events === undefined)
                throw new Error("missing expected event references");
              expect(value).toEqual(
                expected.events.map((key) => fixtureEvent(scenario, key)),
              );
              break;
            default:
              throw new Error("missing operation expectation");
          }
        }
        const notifications = onRetentionFailure.mock.calls
          .slice(notificationStart)
          .map(([failure]) => failure.kind);
        expect(
          error.mock.calls.slice(loggerStart).map(([failure]) => failure.kind),
        ).toEqual(notifications);
        if (step.observe?.notifications !== undefined)
          expect(notifications).toEqual(step.observe.notifications);
        if (step.observe?.history !== undefined) {
          const record = records.get("Order-9");
          if (record === undefined)
            throw new Error("missing committed history owner");
          const active = record.history.map((snapshot) => snapshot.seqNr);
          expect(active).toEqual(step.observe.history.active);
          for (const seqNr of step.observe.history.absent)
            expect(active).not.toContain(seqNr);
          for (const snapshot of record.history)
            expect(snapshot).not.toHaveProperty("ttl");
          expect(step.observe.history.marked).toEqual([]);
        }
        for (const [index, fault] of faults.entries()) {
          if (fault.operation === operation)
            expect(applications[index]).toBe(fault.repeat.count);
        }
        observations.push({
          operation,
          result: result.type,
          ...(result.type === "err" &&
          result.error.type === "contract-violation"
            ? { rule: result.error.rule }
            : {}),
          records: [...records].map(([aid, record]) => ({
            aid,
            headSeqNr: record.head.seqNr,
            journal: record.events.map((event) => event.seqNr),
            currentSeqNr: record.snapshot?.seqNr,
            history: record.history.map((snapshot) => snapshot.seqNr),
          })),
          notifications,
        });
      }
      expect(applications).toEqual(faults.map((fault) => fault.repeat.count));
      console.log(
        JSON.stringify({
          caseId,
          observations,
          faultApplications: applications,
        }),
      );
    },
  );
});
