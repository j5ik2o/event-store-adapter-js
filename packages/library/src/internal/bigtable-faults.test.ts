import type { BigtableEventStoreInput } from "../bigtable-event-store-input";
import type { BigtableJournalWriteFailure } from "../bigtable-journal-write-failure";
import type { RetentionFailure } from "../retention-failure";
import { initializeBigtableStoreInternal } from "./bigtable-event-store";
import type { BigtableEventStoreHooks } from "./bigtable-event-store-hooks";
import { aggregatePrefix, journalRowKey } from "./bigtable-row-keys";
import { logNotificationFailure } from "./retention-failure-notification";
import { BigtableEmulator } from "./test/bigtable-emulator";
import {
  eventOf,
  FAMILY,
  headSeqNrBytes,
  id,
  snapshotOf,
  unwrap,
} from "./test/bigtable-fixture";

let emulator: BigtableEmulator;
beforeAll(async () => {
  emulator = await BigtableEmulator.start();
}, 300000);
afterAll(async () => {
  await emulator.stop();
}, 60000);

async function ready(
  input: Partial<BigtableEventStoreInput<unknown, unknown>> = {},
  hooks?: BigtableEventStoreHooks,
) {
  const tables = await emulator.createTables();
  const full = {
    bigtable: emulator.bigtable,
    instanceId: emulator.instanceId,
    tables,
    ...input,
  };
  unwrap(await initializeBigtableStoreInternal(full, hooks));
  const { openBigtableEventStoreInternal } = await import(
    "./bigtable-event-store"
  );
  const store = unwrap(await openBigtableEventStoreInternal(full, hooks));
  return { tables, store };
}
const prefixOf = (value: string) => aggregatePrefix(`Order-${value}`);

describe("failures before and at the commit point", () => {
  test("a failure writing the previous event stops the append before the head moves", async () => {
    const { store, tables } = await ready(
      {},
      {
        journalWritePrevious: () => {
          throw new Error("previous write failed");
        },
      },
    );
    unwrap(await store.persistEvent(eventOf("f1", 1)));
    expect(await store.persistEvent(eventOf("f1", 2))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    const head = await emulator.readRow(tables.head, prefixOf("f1"));
    expect(
      head?.[FAMILY.head]?.seq_nr?.[0].value.equals(headSeqNrBytes(1)),
    ).toBe(true);
  });

  test("a lost response to the conditional update is a storage error and the request is not sent again", async () => {
    let commits = 0;
    const { store, tables } = await ready(
      {},
      {
        beforeCommit: () => {
          commits += 1;
        },
        afterCommit: () => {
          throw new Error("response lost");
        },
      },
    );
    const result = await store.persistEvent(eventOf("f2", 1));
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(commits).toBe(1);
    // 応答を失っても、更新は保存先に届いている。
    const head = await emulator.readRow(tables.head, prefixOf("f2"));
    expect(
      head?.[FAMILY.head]?.seq_nr?.[0].value.equals(headSeqNrBytes(1)),
    ).toBe(true);
  });

  test("a competing append between the head read and the conditional update is an optimistic lock conflict", async () => {
    const tables = await emulator.createTables();
    const full = {
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
      tables,
    };
    unwrap(await initializeBigtableStoreInternal(full));
    const { openBigtableEventStoreInternal } = await import(
      "./bigtable-event-store"
    );
    const rival = unwrap(await openBigtableEventStoreInternal(full));
    let raced = false;
    const racer = unwrap(
      await openBigtableEventStoreInternal(full, {
        beforeCommit: async () => {
          if (raced) return;
          raced = true;
          unwrap(await rival.persistEvent(eventOf("f3", 1)));
        },
      }),
    );
    expect(await racer.persistEvent(eventOf("f3", 1))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict" },
    });
    expect(
      unwrap(await rival.getEventsByIdSinceSeqNr(id("f3"), 1)),
    ).toHaveLength(1);
  });
});

describe("notifications never change a committed append", () => {
  const throwers: readonly [string, () => never][] = [
    [
      "a synchronous Error",
      () => {
        throw new Error("sync");
      },
    ],
    [
      "an AssertionError-like Error",
      () => {
        throw Object.assign(new Error("assertion"), { name: "AssertionError" });
      },
    ],
  ];

  test.each(throwers)(
    "a journal-write failure notification that throws %s still leaves the append ok",
    async (_name, thrower) => {
      const calls: BigtableJournalWriteFailure[] = [];
      const logged: unknown[][] = [];
      const { store, tables } = await ready(
        {
          onJournalWriteFailure: (failure) => {
            calls.push(failure);
            thrower();
          },
          logger: {
            debug() {},
            info() {},
            warn() {},
            error: (...c: unknown[]) => {
              logged.push(c);
              throw new Error("logger throws");
            },
          },
        },
        {
          journalWriteTail: () => {
            throw new Error("tail write failed");
          },
        },
      );
      unwrap(await store.persistEvent(eventOf("n1", 1)));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        kind: "journal-write-failure",
        aggregateId: "Order-n1",
        seqNr: 1,
      });
      expect(logged.length).toBeGreaterThan(0);
      const head = await emulator.readRow(tables.head, prefixOf("n1"));
      expect(
        head?.[FAMILY.head]?.seq_nr?.[0].value.equals(headSeqNrBytes(1)),
      ).toBe(true);
      // 書き出せなかった末尾の行は、次の追記が直前のイベントとして補う。
      unwrap(await store.persistEvent(eventOf("n1", 2)));
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(id("n1"), 1)).map(
          (e) => e.seqNr,
        ),
      ).toEqual([1, 2]);
      const row = await emulator.readRow(
        tables.journal,
        journalRowKey(prefixOf("n1"), 1),
      );
      expect(row?.[FAMILY.event]?.envelope).toBeDefined();
    },
  );

  test.each(throwers)(
    "a retention failure notification that throws %s still leaves the append ok",
    async (_name, thrower) => {
      const failures: RetentionFailure[] = [];
      const errors: unknown[][] = [];
      const { store } = await ready(
        {
          retention: { count: 1 },
          onRetentionFailure: (failure) => {
            failures.push(failure);
            thrower();
          },
          logger: {
            debug() {},
            info() {},
            warn() {},
            error: (...c: unknown[]) => {
              errors.push(c);
            },
          },
        },
        {
          beforeRetentionDelete: () => {
            throw new Error("retention delete failed");
          },
        },
      );
      unwrap(await store.persistEvent(eventOf("n2", 1)));
      unwrap(
        await store.persistEventAndSnapshot(eventOf("n2", 2), snapshotOf(2)),
      );
      unwrap(
        await store.persistEventAndSnapshot(eventOf("n2", 3), snapshotOf(3)),
      );
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0]).toMatchObject({
        kind: "retention-failure",
        aggregateId: "Order-n2",
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(
        unwrap(await store.getLatestSnapshotById(id("n2")))?.snapshot?.seqNr,
      ).toBe(3);
    },
  );

  test("an asynchronous rejection from the callback is also absorbed and the callback was invoked", async () => {
    const calls: unknown[] = [];
    const { store } = await ready(
      {
        onJournalWriteFailure: async (failure) => {
          calls.push(failure);
          throw new Error("async rejection");
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      },
      {
        journalWriteTail: () => {
          throw new Error("tail write failed");
        },
      },
    );
    unwrap(await store.persistEvent(eventOf("n3", 1)));
    expect(calls).toHaveLength(1);
  });

  test("logNotificationFailure survives a logger and a console that both throw", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console throws");
    });
    try {
      await expect(
        logNotificationFailure(
          {
            debug() {},
            info() {},
            warn() {},
            error: () => {
              throw new Error("logger throws");
            },
          },
          new Error("cause"),
        ),
      ).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
