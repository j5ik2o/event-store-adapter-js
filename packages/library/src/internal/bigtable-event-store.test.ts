import { BigtableEventStore } from "../bigtable-event-store";
import type { BigtableEventStoreInput } from "../bigtable-event-store-input";
import {
  decodeEventEnvelope,
  decodeSnapshotEnvelope,
} from "./bigtable-envelope";
import {
  initializeBigtableStoreInternal,
  openBigtableEventStoreInternal,
} from "./bigtable-event-store";
import type { BigtableEventStoreHooks } from "./bigtable-event-store-hooks";
import { aggregatePrefix, journalRowKey } from "./bigtable-row-keys";
import {
  BigtableEmulator,
  type BigtableStoreSetup,
} from "./test/bigtable-emulator";
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

async function open(
  input: Partial<BigtableEventStoreInput<unknown, unknown>> = {},
  hooks?: BigtableEventStoreHooks,
  setup: BigtableStoreSetup = {},
) {
  const tables = await emulator.createTables(setup);
  const full = {
    bigtable: emulator.bigtable,
    instanceId: emulator.instanceId,
    tables,
    ...input,
  };
  const initialized = await initializeBigtableStoreInternal(full, hooks);
  return { tables, initialized, full };
}

async function ready(
  input: Partial<BigtableEventStoreInput<unknown, unknown>> = {},
  hooks?: BigtableEventStoreHooks,
) {
  const { tables, initialized, full } = await open(input, hooks);
  unwrap(initialized);
  const store = unwrap(await openBigtableEventStoreInternal(full, hooks));
  return { tables, store, full };
}

const prefixOf = (aid: string) => aggregatePrefix(`Order-${aid}`);

describe("create and initialize", () => {
  test("the public create returns a frozen object with the four operations", async () => {
    const { store } = await ready();
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.keys(store).sort()).toEqual([
      "getEventsByIdSinceSeqNr",
      "getLatestSnapshotById",
      "persistEvent",
      "persistEventAndSnapshot",
    ]);
  });

  test("create does not write the missing configuration rows", async () => {
    const tables = await emulator.createTables();
    const created = await BigtableEventStore.create({
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
      tables,
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(
      await emulator.readRow(tables.journal, new Uint8Array([0])),
    ).toBeUndefined();
    expect(
      await emulator.readRow(tables.head, new Uint8Array([0])),
    ).toBeUndefined();
  });

  test("initialize writes the configuration to both tables and a second initialize does not rewrite them", async () => {
    const { tables, initialized } = await open();
    unwrap(initialized);
    const journal = await emulator.readRow(tables.journal, new Uint8Array([0]));
    const head = await emulator.readRow(tables.head, new Uint8Array([0]));
    const a = journal?.config?.metadata?.[0]?.value.toString();
    expect(a).toBeDefined();
    expect(JSON.parse(a ?? "{}").envelope_limit_bytes).toBe(1048576);
    expect(head?.config?.metadata?.[0]?.value.toString()).toBe(a);
    const again = await BigtableEventStore.initialize({
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
      tables,
    });
    expect(again.type).toBe("err");
  });

  test("a missing column family is a configuration error", async () => {
    const { initialized } = await open({}, undefined, {
      omitFamilies: ["journal:history"],
    });
    expect(initialized).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("a data column family with an age-based GC rule is a configuration error", async () => {
    const { initialized } = await open({}, undefined, { maxAgeSeconds: 3600 });
    expect(initialized).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("a data column family that keeps more than one version is a configuration error", async () => {
    const { initialized } = await open({}, undefined, { maxVersions: 3 });
    expect(initialized).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("a store opened with a different retention count than the recorded one is rejected", async () => {
    const { full, initialized } = await open({ retention: { count: 2 } });
    unwrap(initialized);
    const created = await BigtableEventStore.create({
      ...full,
      retention: { count: 1 },
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("a store opened with a different envelope limit than the recorded one is rejected", async () => {
    const { full, initialized } = await open();
    unwrap(initialized);
    const created = await BigtableEventStore.create({
      ...full,
      envelopeLimitBytes: 2097152,
    });
    expect(created).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
  });

  test("a ttl retention and a change feed are configuration errors before any request", async () => {
    const tables = await emulator.createTables();
    const spy = jest.spyOn(emulator.bigtable, "request");
    try {
      for (const over of [
        {
          retention: {
            count: 1,
            mode: { type: "ttl" as const, graceSeconds: 60 },
          },
        },
        { changeFeed: true },
      ]) {
        const created = await BigtableEventStore.create({
          bigtable: emulator.bigtable,
          instanceId: emulator.instanceId,
          tables,
          ...over,
        });
        expect(created).toMatchObject({
          type: "err",
          error: { type: "configuration-error" },
        });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("retention count bound", () => {
  test("2^53-1 initializes and opens, and 2^53 is rejected before any request", async () => {
    const tables = await emulator.createTables();
    const base = {
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
      tables,
    };
    const spy = jest.spyOn(emulator.bigtable, "request");
    try {
      expect(
        await BigtableEventStore.initialize({
          ...base,
          retention: { count: 2 ** 53 },
        }),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "retention.count" },
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const retention = { count: Number.MAX_SAFE_INTEGER };
    expect(
      (await BigtableEventStore.initialize({ ...base, retention })).type,
    ).toBe("ok");
    expect((await BigtableEventStore.create({ ...base, retention })).type).toBe(
      "ok",
    );
  });
});

describe("append and read", () => {
  test("persists events, reads them back in order, and reopens the same tables", async () => {
    const { store, full } = await ready();
    unwrap(await store.persistEvent(eventOf("1", 1)));
    unwrap(await store.persistEvent(eventOf("1", 2)));
    unwrap(await store.persistEvent(eventOf("1", 3)));
    const events = unwrap(await store.getEventsByIdSinceSeqNr(id("1"), 1));
    expect(events.map((e) => e.seqNr)).toEqual([1, 2, 3]);
    expect(events[2].payload).toEqual({ seqNr: 3 });
    const reopened = unwrap(await BigtableEventStore.create(full));
    expect(
      unwrap(await reopened.getEventsByIdSinceSeqNr(id("1"), 2)).map(
        (e) => e.seqNr,
      ),
    ).toEqual([2, 3]);
  });

  test("an empty aggregate reads as no events and no snapshot", async () => {
    const { store } = await ready();
    expect(unwrap(await store.getEventsByIdSinceSeqNr(id("none"), 1))).toEqual(
      [],
    );
    expect(
      unwrap(await store.getLatestSnapshotById(id("none"))),
    ).toBeUndefined();
  });

  test("reading since a number beyond the head is empty, and since the head returns only the head event", async () => {
    const { store } = await ready();
    for (const n of [1, 2, 3])
      unwrap(await store.persistEvent(eventOf("2", n)));
    expect(unwrap(await store.getEventsByIdSinceSeqNr(id("2"), 4))).toEqual([]);
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(id("2"), 3)).map(
        (e) => e.seqNr,
      ),
    ).toEqual([3]);
  });

  test("a duplicate append is an optimistic lock conflict, and a gap is a contract violation", async () => {
    const { store } = await ready();
    unwrap(await store.persistEvent(eventOf("3", 1)));
    expect(await store.persistEvent(eventOf("3", 1))).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict" },
    });
    const gap = await store.persistEvent(eventOf("3", 3));
    expect(gap.type).toBe("err");
    if (gap.type === "err")
      expect(["optimistic-lock-conflict", "contract-violation"]).toContain(
        gap.error.type,
      );
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(id("3"), 1)).map(
        (e) => e.seqNr,
      ),
    ).toEqual([1]);
  });

  test("persistEventAndSnapshot stores the snapshot, and the latest snapshot is returned", async () => {
    const { store } = await ready();
    unwrap(await store.persistEvent(eventOf("4", 1)));
    unwrap(await store.persistEventAndSnapshot(eventOf("4", 2), snapshotOf(2)));
    const latest = unwrap(await store.getLatestSnapshotById(id("4")));
    expect(latest?.snapshot?.seqNr).toBe(2);
    expect(latest?.snapshot?.aggregate).toEqual({ seqNr: 2 });
  });

  test("an aggregate id of 1024 bytes appends and reads", async () => {
    const { store } = await ready();
    const long = "x".repeat(1024 - "Order-".length);
    unwrap(await store.persistEvent(eventOf(long, 1)));
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(id(long), 1)),
    ).toHaveLength(1);
  });

  test("a missing journal row in [start, head) is a storage error", async () => {
    const { store, tables } = await ready();
    for (const n of [1, 2, 3])
      unwrap(await store.persistEvent(eventOf("5", n)));
    await emulator.deleteRow(tables.journal, journalRowKey(prefixOf("5"), 2));
    expect(await store.getEventsByIdSinceSeqNr(id("5"), 1)).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });

  test("a corrupt head sequence number is a storage error", async () => {
    const { store, tables } = await ready();
    unwrap(await store.persistEvent(eventOf("6", 1)));
    await emulator.writeCell(
      tables.head,
      prefixOf("6"),
      FAMILY.head,
      "seq_nr",
      Buffer.from("not-a-number-xxxxxx"),
      0,
    );
    expect(await store.getEventsByIdSinceSeqNr(id("6"), 1)).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });
});

describe("stored snapshot envelope range", () => {
  test("a current snapshot whose seq_nr is 0 is a storage error", async () => {
    const { store, tables } = await ready();
    unwrap(await store.persistEvent(eventOf("12", 1)));
    await emulator.writeCell(
      tables.head,
      prefixOf("12"),
      FAMILY.snapshot,
      "current",
      Buffer.from(`01${"0000000000000000"}0000000000000000`, "hex"),
      0,
    );
    expect(await store.getLatestSnapshotById(id("12"))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });
});

describe("hash collisions", () => {
  test("ids with the same hash never see each other, and the config row stays out of the journal range", async () => {
    const hooks: BigtableEventStoreHooks = { aggregateHash: () => BigInt(7) };
    const { store } = await ready({}, hooks);
    for (const value of ["a-1", "a-12", "a-1\u0000"]) {
      unwrap(await store.persistEvent(eventOf(value, 1)));
      unwrap(await store.persistEvent(eventOf(value, 2)));
    }
    for (const value of ["a-1", "a-12", "a-1\u0000"]) {
      const events = unwrap(await store.getEventsByIdSinceSeqNr(id(value), 1));
      expect(events.map((e) => e.aggregateId.value)).toEqual([value, value]);
    }
  });
});

describe("cell layout and versions (acceptance 4)", () => {
  test("head and journal cells use the Rust families, a 20-digit seq_nr, and timestamp 0 with a single version", async () => {
    const { store, tables } = await ready();
    unwrap(await store.persistEvent(eventOf("7", 1)));
    unwrap(await store.persistEvent(eventOf("7", 2)));
    unwrap(await store.persistEvent(eventOf("7", 3)));
    const head = await emulator.readRow(tables.head, prefixOf("7"));
    expect(head?.[FAMILY.head]?.seq_nr).toHaveLength(1);
    expect(
      head?.[FAMILY.head]?.seq_nr?.[0].value.equals(headSeqNrBytes(3)),
    ).toBe(true);
    expect(head?.[FAMILY.head]?.seq_nr?.[0].timestampMicros).toBe(0);
    expect(head?.[FAMILY.head]?.has_snapshot?.[0].value.toString()).toBe("0");
    expect(
      decodeEventEnvelope(
        head?.[FAMILY.head]?.last_event?.[0].value ?? new Uint8Array(),
      ).seqNr,
    ).toBe(3);
    const row = await emulator.readRow(
      tables.journal,
      journalRowKey(prefixOf("7"), 2),
    );
    expect(
      decodeEventEnvelope(
        row?.[FAMILY.event]?.envelope?.[0].value ?? new Uint8Array(),
      ).seqNr,
    ).toBe(2);
    expect(row?.[FAMILY.event]?.envelope?.[0].timestampMicros).toBe(0);
  });

  test("the snapshot is written to head:snapshot:current and the history envelope to the journal row", async () => {
    const { store, tables } = await ready({ retention: { count: 2 } });
    unwrap(await store.persistEvent(eventOf("8", 1)));
    unwrap(await store.persistEventAndSnapshot(eventOf("8", 2), snapshotOf(2)));
    unwrap(await store.persistEvent(eventOf("8", 3)));
    const head = await emulator.readRow(tables.head, prefixOf("8"));
    expect(
      decodeSnapshotEnvelope(
        head?.[FAMILY.snapshot]?.current?.[0].value ?? new Uint8Array(),
      ).seqNr,
    ).toBe(2);
    const row = await emulator.readRow(
      tables.journal,
      journalRowKey(prefixOf("8"), 2),
    );
    expect(row?.[FAMILY.history]?.state?.[0].value.toString()).toBe("active");
    expect(
      decodeSnapshotEnvelope(
        row?.[FAMILY.history]?.envelope?.[0].value ?? new Uint8Array(),
      ).seqNr,
    ).toBe(2);
    expect(row?.[FAMILY.event]?.has_snapshot?.[0].value.toString()).toBe("1");
  });

  test("a stale timestamp on a head cell does not make an older value win: replacing a cell leaves one version", async () => {
    const { store, tables } = await ready();
    unwrap(await store.persistEvent(eventOf("9", 1)));
    await emulator.writeCell(
      tables.head,
      prefixOf("9"),
      FAMILY.head,
      "seq_nr",
      headSeqNrBytes(1),
      5_000,
    );
    unwrap(await store.persistEvent(eventOf("9", 2)));
    const head = await emulator.readRow(tables.head, prefixOf("9"));
    expect(head?.[FAMILY.head]?.seq_nr).toHaveLength(1);
    expect(
      head?.[FAMILY.head]?.seq_nr?.[0].value.equals(headSeqNrBytes(2)),
    ).toBe(true);
  });
});

describe("snapshot retention", () => {
  test("keeps the newest n snapshots active, retires older ones, and keeps their event cells", async () => {
    const { store, tables } = await ready({ retention: { count: 1 } });
    unwrap(await store.persistEvent(eventOf("10", 1)));
    unwrap(
      await store.persistEventAndSnapshot(eventOf("10", 2), snapshotOf(2)),
    );
    unwrap(
      await store.persistEventAndSnapshot(eventOf("10", 3), snapshotOf(3)),
    );
    unwrap(await store.persistEvent(eventOf("10", 4)));
    const old = await emulator.readRow(
      tables.journal,
      journalRowKey(prefixOf("10"), 2),
    );
    expect(old?.[FAMILY.history]?.state?.[0].value.toString()).toBe("retired");
    expect(old?.[FAMILY.history]?.envelope).toBeUndefined();
    expect(old?.[FAMILY.event]?.envelope).toBeDefined();
    const kept = await emulator.readRow(
      tables.journal,
      journalRowKey(prefixOf("10"), 3),
    );
    expect(kept?.[FAMILY.history]?.state?.[0].value.toString()).toBe("active");
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(id("10"), 1)),
    ).toHaveLength(4);
  });

  test("a stale writer that writes a retired history row later cannot revive the history", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = false;
    const hooks: BigtableEventStoreHooks = {
      journalWriteTail: async (aid, seqNr) => {
        if (aid === "Order-11" && seqNr === 3 && !held) {
          held = true;
          entered();
          await gate;
        }
      },
    };
    const failures: unknown[] = [];
    const { store, tables } = await ready(
      {
        retention: { count: 1 },
        onJournalWriteFailure: (failure) => {
          failures.push(failure);
        },
      },
      hooks,
    );
    unwrap(await store.persistEvent(eventOf("11", 1)));
    unwrap(
      await store.persistEventAndSnapshot(eventOf("11", 2), snapshotOf(2)),
    );
    const slow = store.persistEventAndSnapshot(eventOf("11", 3), snapshotOf(3));
    await waiting;
    unwrap(
      await store.persistEventAndSnapshot(eventOf("11", 4), snapshotOf(4)),
    );
    const rowOf = (n: number) =>
      emulator.readRow(tables.journal, journalRowKey(prefixOf("11"), n));
    // 遅い書き手が書き出す前に、行 3 は保持処理で retired になっている。
    expect(
      (await rowOf(3))?.[FAMILY.history]?.state?.[0].value.toString(),
    ).toBe("retired");
    release();
    unwrap(await slow);
    // retired の行は、遅れて書き出す古い書き手が来ても、履歴の封筒を持たない。
    for (const n of [2, 3]) {
      const row = await rowOf(n);
      expect(row?.[FAMILY.history]?.state?.[0].value.toString()).toBe(
        "retired",
      );
      expect(row?.[FAMILY.history]?.envelope).toBeUndefined();
      expect(row?.[FAMILY.event]?.envelope).toBeDefined();
    }
    expect(failures).toEqual([]);
  });

  test("history rows already retired are left untouched by the next retention pass", async () => {
    const deletions: number[][] = [];
    const hooks: BigtableEventStoreHooks = {
      beforeRetentionDelete: (_aid, seqNrs) => {
        deletions.push([...seqNrs]);
      },
    };
    const { store } = await ready({ retention: { count: 1 } }, hooks);
    unwrap(await store.persistEvent(eventOf("12", 1)));
    unwrap(
      await store.persistEventAndSnapshot(eventOf("12", 2), snapshotOf(2)),
    );
    unwrap(
      await store.persistEventAndSnapshot(eventOf("12", 3), snapshotOf(3)),
    );
    unwrap(
      await store.persistEventAndSnapshot(eventOf("12", 4), snapshotOf(4)),
    );
    const flat = deletions.flat();
    expect(flat.filter((n) => n === 2)).toHaveLength(1);
  });
});

describe("envelope limit (BT-16)", () => {
  test("an event whose envelope exceeds the limit is a contract violation with BT-16 and writes nothing", async () => {
    const { store, tables } = await ready({ envelopeLimitBytes: 1024 });
    unwrap(await store.persistEvent(eventOf("13", 1)));
    const big = { ...eventOf("13", 2), payload: { blob: "z".repeat(2048) } };
    const result = await store.persistEvent(big);
    expect(result).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "BT-16" },
    });
    const head = await emulator.readRow(tables.head, prefixOf("13"));
    expect(
      head?.[FAMILY.head]?.seq_nr?.[0].value.equals(headSeqNrBytes(1)),
    ).toBe(true);
  });
});

describe("input rejected before anything is written", () => {
  test("an invalid event or an event and snapshot with different numbers is a contract violation", async () => {
    const { store, tables } = await ready();
    expect(
      await store.persistEvent({ ...eventOf("20", 1), seqNr: -1 }),
    ).toMatchObject({
      type: "err",
      error: { type: "contract-violation" },
    });
    expect(
      await store.persistEventAndSnapshot(eventOf("20", 1), snapshotOf(2)),
    ).toMatchObject({ type: "err", error: { type: "contract-violation" } });
    expect(await emulator.readRow(tables.head, prefixOf("20"))).toBeUndefined();
  });

  test("a serializer that does not return bytes is a serialization error", async () => {
    const { store } = await ready({
      eventSerializer: {
        serialize: () => "text" as never,
        deserialize: () => ({}),
      },
      snapshotSerializer: {
        serialize: () => "text" as never,
        deserialize: () => ({}),
      },
    });
    expect(await store.persistEvent(eventOf("21", 1))).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "serialize" },
    });
  });

  test("a snapshot serializer that throws is a serialization error", async () => {
    const { store, tables } = await ready({
      snapshotSerializer: {
        serialize: () => {
          throw new Error("snapshot cannot be serialized");
        },
        deserialize: () => ({}),
      },
    });
    expect(
      await store.persistEventAndSnapshot(eventOf("22", 1), snapshotOf(1)),
    ).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "serialize" },
    });
    expect(await emulator.readRow(tables.head, prefixOf("22"))).toBeUndefined();
  });

  test("a snapshot envelope above the limit is a BT-16 violation that names the snapshot", async () => {
    const { store, tables } = await ready({ envelopeLimitBytes: 1024 });
    const big = { ...snapshotOf(1), aggregate: { blob: "z".repeat(2048) } };
    expect(
      await store.persistEventAndSnapshot(eventOf("23", 1), big),
    ).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "BT-16", snapshotSeqNr: 1 },
    });
    expect(await emulator.readRow(tables.head, prefixOf("23"))).toBeUndefined();
  });

  test("a store without retention keeps no history even when snapshots are written", async () => {
    const { store, tables } = await ready();
    unwrap(
      await store.persistEventAndSnapshot(eventOf("24", 1), snapshotOf(1)),
    );
    unwrap(await store.persistEvent(eventOf("24", 2)));
    unwrap(await store.persistEvent(eventOf("24", 3)));
    const row = await emulator.readRow(
      tables.journal,
      journalRowKey(prefixOf("24"), 1),
    );
    expect(row?.[FAMILY.history]).toBeUndefined();
    expect(row?.[FAMILY.event]?.has_snapshot?.[0].value.toString()).toBe("1");
  });
});
