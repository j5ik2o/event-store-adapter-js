import type { Result } from "../result";
import { EventEnvelope } from "./event-envelope";
import type { EventStoreError } from "./event-store-error";
import {
  commitMemoryStorageRecords,
  inspectMemoryStorageRecords,
} from "./internal/memory-storage-records";
import { MemoryStorage } from "./memory-storage";
import { SnapshotEnvelope } from "./snapshot-envelope";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message);
  return result.value;
}

const occurredAt = Date.parse("2026-10-08T00:00:00.123Z");

function event(seqNr: number, value = "1"): EventEnvelope<Uint8Array> {
  return unwrap(
    EventEnvelope.create({
      aggregateId: { typeName: "Order", value },
      seqNr,
      occurredAt: new Date(occurredAt),
      manifest: `event-${seqNr}`,
      payload: Uint8Array.of(seqNr),
    }),
  );
}

function snapshot(seqNr: number): SnapshotEnvelope<Uint8Array> {
  return unwrap(
    SnapshotEnvelope.create({
      seqNr,
      manifest: `snapshot-${seqNr}`,
      aggregate: Uint8Array.of(seqNr, seqNr),
    }),
  );
}

describe("MemoryStorage.create", () => {
  test("creates an empty independent destination with no retention by default", async () => {
    const storage = unwrap(MemoryStorage.create());

    expect(unwrap(await inspectMemoryStorageRecords(storage))).toEqual({
      configuration: { retention: undefined },
      records: new Map(),
    });
  });

  test.each([1, 2 ** 53])(
    "accepts integer count %p and defaults its mode to delete",
    async (count) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count } }));

      expect(
        unwrap(await inspectMemoryStorageRecords(storage)).configuration,
      ).toEqual({ retention: { count, mode: { type: "delete" } } });
    },
  );

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects count %p at the generation entry",
    (count) => {
      expect(MemoryStorage.create({ retention: { count } })).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "retention.count" },
      });
    },
  );

  test.each([
    [0, "retention.mode.type"],
    [Number.MAX_SAFE_INTEGER, "retention.mode.type"],
    [-1, "retention.mode.graceSeconds"],
    [0.5, "retention.mode.graceSeconds"],
    [2 ** 53, "retention.mode.graceSeconds"],
  ])(
    "validates graceSeconds %p before rejecting unsupported ttl",
    (graceSeconds, fieldName) => {
      expect(
        MemoryStorage.create({
          retention: { count: 1, mode: { type: "ttl", graceSeconds } },
        }),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName },
      });
    },
  );

  test.each([false, null, 0, {}])(
    "rejects a defined changeFeed request %p",
    (changeFeed) => {
      expect(MemoryStorage.create({ changeFeed })).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "changeFeed" },
      });
    },
  );

  test.each([null, []])("rejects invalid settings %p", (input) => {
    expect(MemoryStorage.create(input as never)).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "input" },
    });
  });

  test("keeps the destination's normalized configuration after input changes", async () => {
    const input = {
      retention: { count: 2, mode: { type: "delete" as const } },
      changeFeed: undefined as unknown,
    };
    const storage = unwrap(MemoryStorage.create(input));
    const before = unwrap(await inspectMemoryStorageRecords(storage));

    input.retention.count = 0;
    Reflect.set(input.retention.mode, "type", "ttl");
    input.changeFeed = true;
    unwrap(await commitMemoryStorageRecords(storage, event(1)));
    const after = unwrap(await inspectMemoryStorageRecords(storage));

    expect(before.configuration).toEqual({
      retention: { count: 2, mode: { type: "delete" } },
    });
    expect(after.configuration).toEqual(before.configuration);
    expect(Reflect.set(after.configuration, "retention", undefined)).toBe(
      false,
    );
    expect(
      Reflect.set(after.configuration.retention as object, "count", 0),
    ).toBe(false);
    expect(
      Reflect.set(after.configuration.retention?.mode as object, "type", "ttl"),
    ).toBe(false);
    expect(
      unwrap(await inspectMemoryStorageRecords(storage)).configuration,
    ).toEqual(before.configuration);
  });
});

describe("MemoryStorage atomic records", () => {
  test("publishes the new head and event together without a snapshot", async () => {
    const storage = unwrap(MemoryStorage.create());

    unwrap(await commitMemoryStorageRecords(storage, event(1)));

    const storedEvent = {
      aggregateId: "Order-1",
      seqNr: 1,
      occurredAt,
      manifest: "event-1",
      payload: Uint8Array.of(1),
    };
    expect(unwrap(await inspectMemoryStorageRecords(storage)).records).toEqual(
      new Map([
        [
          "Order-1",
          {
            head: storedEvent,
            events: [storedEvent],
            snapshot: undefined,
            history: [],
          },
        ],
      ]),
    );
  });

  test.each([undefined, 1])(
    "commits snapshots and preserves current snapshot and history on event-only updates (retention count=%p)",
    async (count) => {
      const storage = unwrap(
        MemoryStorage.create(
          count === undefined ? undefined : { retention: { count } },
        ),
      );
      unwrap(await commitMemoryStorageRecords(storage, event(1), snapshot(1)));
      const first = unwrap(
        await inspectMemoryStorageRecords(storage),
      ).records.get("Order-1");
      expect(first).toMatchObject({
        head: { seqNr: 1, payload: Uint8Array.of(1) },
        events: [{ seqNr: 1, payload: Uint8Array.of(1) }],
        snapshot: snapshot(1),
        history: count === undefined ? [] : [snapshot(1)],
      });

      unwrap(await commitMemoryStorageRecords(storage, event(2)));
      const second = unwrap(
        await inspectMemoryStorageRecords(storage),
      ).records.get("Order-1");
      expect(second).toMatchObject({
        head: { seqNr: 2, payload: Uint8Array.of(2) },
        events: [{ seqNr: 1 }, { seqNr: 2 }],
        snapshot: snapshot(1),
        history: count === undefined ? [] : [snapshot(1)],
      });

      unwrap(await commitMemoryStorageRecords(storage, event(3), snapshot(3)));
      expect(
        unwrap(await inspectMemoryStorageRecords(storage)).records.get(
          "Order-1",
        ),
      ).toMatchObject({
        head: { seqNr: 3, payload: Uint8Array.of(3) },
        events: [{ seqNr: 1 }, { seqNr: 2 }, { seqNr: 3 }],
        snapshot: snapshot(3),
        history: count === undefined ? [] : [snapshot(3)],
      });
    },
  );

  test.each(["event", "snapshot"])(
    "%s byte preparation failure leaves every record unchanged",
    async (target) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      unwrap(await commitMemoryStorageRecords(storage, event(1), snapshot(1)));
      const before = unwrap(await inspectMemoryStorageRecords(storage));
      const detached = Uint8Array.of(2);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });

      const result = await commitMemoryStorageRecords(
        storage,
        {
          ...event(2),
          payload: target === "event" ? detached : Uint8Array.of(2),
        },
        {
          ...snapshot(2),
          aggregate: target === "snapshot" ? detached : Uint8Array.of(2, 2),
        },
      );

      expect(result).toMatchObject({
        type: "err",
        error: {
          type: "storage-error",
          cause: expect.objectContaining({ name: "TypeError" }),
        },
      });
      expect(unwrap(await inspectMemoryStorageRecords(storage))).toEqual(
        before,
      );
      unwrap(await commitMemoryStorageRecords(storage, event(2), snapshot(2)));
      expect(
        unwrap(await inspectMemoryStorageRecords(storage)).records.get(
          "Order-1",
        ),
      ).toMatchObject({
        head: { seqNr: 2 },
        snapshot: snapshot(2),
        history: [snapshot(2)],
      });
    },
  );

  test.each([false, true])(
    "failure immediately before publication preserves records (existing=%p) and releases the queue",
    async (existing) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      if (existing) {
        unwrap(
          await commitMemoryStorageRecords(storage, event(1), snapshot(1)),
        );
      }
      const before = unwrap(await inspectMemoryStorageRecords(storage));
      const seqNr = existing ? 2 : 1;
      const cause = new Error("injected preparation failure");

      const result = await commitMemoryStorageRecords(
        storage,
        event(seqNr),
        snapshot(seqNr),
        async () => {
          throw cause;
        },
      );

      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error", cause },
      });
      expect(unwrap(await inspectMemoryStorageRecords(storage))).toEqual(
        before,
      );
      unwrap(
        await commitMemoryStorageRecords(
          storage,
          event(seqNr),
          snapshot(seqNr),
        ),
      );
      expect(
        unwrap(await inspectMemoryStorageRecords(storage)).records.get(
          "Order-1",
        ),
      ).toMatchObject({
        head: { seqNr },
        snapshot: snapshot(seqNr),
        history: [snapshot(seqNr)],
      });
    },
  );

  test.each([false, true])(
    "only one parallel request for the same number commits and readers wait (existing=%p)",
    async (existing) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 2 } }));
      if (existing) unwrap(await commitMemoryStorageRecords(storage, event(1)));
      const seqNr = existing ? 2 : 1;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const first = commitMemoryStorageRecords(
        storage,
        event(seqNr),
        snapshot(seqNr),
        () => {
          entered.resolve();
          return release.promise;
        },
      );
      await entered.promise;
      const second = commitMemoryStorageRecords(
        storage,
        { ...event(seqNr), payload: Uint8Array.of(99) },
        { ...snapshot(seqNr), aggregate: Uint8Array.of(99) },
      );
      const observed = jest.fn();
      const reading = inspectMemoryStorageRecords(storage).then((result) => {
        observed();
        return result;
      });
      try {
        await Promise.resolve();
        expect(observed).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }

      const [firstResult, secondResult, observation] = await Promise.all([
        first,
        second,
        reading,
      ]);

      expect(firstResult.type).toBe("ok");
      expect(secondResult).toMatchObject({
        type: "err",
        error: {
          type: "optimistic-lock-conflict",
          aggregateId: "Order-1",
          seqNr,
          headSeqNr: seqNr,
        },
      });
      const records = unwrap(observation).records.get("Order-1");
      expect(records).toMatchObject({
        head: { seqNr, payload: Uint8Array.of(seqNr) },
        snapshot: snapshot(seqNr),
        history: [snapshot(seqNr)],
      });
      expect(records?.events.map((saved) => saved.seqNr)).toEqual(
        existing ? [1, 2] : [1],
      );
      expect(unwrap(observation).configuration).toEqual({
        retention: { count: 2, mode: { type: "delete" } },
      });
    },
  );

  test("different destinations isolate records, configuration and locks", async () => {
    const firstStorage = unwrap(
      MemoryStorage.create({ retention: { count: 1 } }),
    );
    const secondStorage = unwrap(
      MemoryStorage.create({ retention: { count: 2 } }),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = commitMemoryStorageRecords(
      firstStorage,
      event(1),
      undefined,
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    await entered.promise;
    try {
      expect(
        unwrap(await inspectMemoryStorageRecords(secondStorage)).records.size,
      ).toBe(0);
      unwrap(
        await commitMemoryStorageRecords(
          secondStorage,
          { ...event(1), payload: Uint8Array.of(99) },
          snapshot(1),
        ),
      );
      const second = unwrap(await inspectMemoryStorageRecords(secondStorage));
      expect(second.configuration.retention?.count).toBe(2);
      expect(second.records.get("Order-1")).toMatchObject({
        head: { payload: Uint8Array.of(99) },
        snapshot: snapshot(1),
        history: [snapshot(1)],
      });
    } finally {
      release.resolve();
      unwrap(await first);
    }
    const firstRecords = unwrap(
      await inspectMemoryStorageRecords(firstStorage),
    );
    expect(firstRecords.configuration.retention?.count).toBe(1);
    expect(firstRecords.records.get("Order-1")).toMatchObject({
      head: { payload: Uint8Array.of(1) },
      snapshot: undefined,
      history: [],
    });
  });
});

describe("MemoryStorage related boundaries", () => {
  test("uses the complete aggregate string and keeps sequence numbers separate", async () => {
    const storage = unwrap(MemoryStorage.create());

    for (const value of ["1", "10", "1-2"]) {
      const envelope = event(1, value);
      unwrap(
        await commitMemoryStorageRecords(storage, {
          ...envelope,
          aggregateId: {
            ...envelope.aggregateId,
            asString: () => "custom-id",
          } as typeof envelope.aggregateId,
        }),
      );
    }
    unwrap(await commitMemoryStorageRecords(storage, event(2, "1")));

    const records = unwrap(await inspectMemoryStorageRecords(storage)).records;
    expect([...records.keys()]).toEqual(["Order-1", "Order-10", "Order-1-2"]);
    expect(records.get("Order-1")?.events.map((saved) => saved.seqNr)).toEqual([
      1, 2,
    ]);
    expect(records.get("Order-10")?.head.seqNr).toBe(1);
    expect(records.get("Order-1-2")?.head.seqNr).toBe(1);
  });

  test.each([
    [1, 1, 1, "optimistic-lock-conflict", undefined],
    [2, 2, 2, "optimistic-lock-conflict", undefined],
    [2, 1, 1, "optimistic-lock-conflict", undefined],
    [1, 3, 3, "contract-violation", "W-8"],
    [0, 2, 2, "contract-violation", "W-8"],
    [1, 2, 1, "contract-violation", "W-9"],
  ])(
    "head=%p event=%p snapshot=%p rejects as %s without changing records",
    async (headSeqNr, seqNr, snapshotSeqNr, type, rule) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 2 } }));
      for (let n = 1; n <= headSeqNr; n += 1) {
        unwrap(
          await commitMemoryStorageRecords(storage, event(n), snapshot(n)),
        );
      }
      const before = unwrap(await inspectMemoryStorageRecords(storage));

      const result = await commitMemoryStorageRecords(
        storage,
        event(seqNr),
        snapshot(snapshotSeqNr),
      );

      expect(result).toMatchObject({
        type: "err",
        error: {
          type,
          seqNr,
          ...(rule === undefined ? { headSeqNr } : { rule }),
          ...(rule === "W-9" ? { snapshotSeqNr } : {}),
        },
      });
      expect(unwrap(await inspectMemoryStorageRecords(storage))).toEqual(
        before,
      );
    },
  );

  test.each([
    [{ seqNr: 0 }, "W-6"],
    [{ seqNr: 2 ** 53 }, "T-9"],
    [{ payload: undefined }, "T-2"],
    [{ occurredAt: new Date(Number.NaN) }, "T-13"],
    [{ aggregateId: { typeName: "Order-Item", value: "1" } }, "T-11"],
    [{ aggregateId: { typeName: "Order", value: "x".repeat(1024) } }, "T-12"],
  ])("reuses envelope and aggregate checks for %p", async (invalid, rule) => {
    const storage = unwrap(MemoryStorage.create());

    expect(
      await commitMemoryStorageRecords(storage, {
        ...event(1),
        ...invalid,
      } as never),
    ).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule },
    });
    expect(
      unwrap(await inspectMemoryStorageRecords(storage)).records.size,
    ).toBe(0);
  });

  test.each([
    [{ seqNr: undefined }, "T-10"],
    [{ seqNr: Number.NaN }, "T-9"],
  ])("reuses snapshot checks for %p", async (invalid, rule) => {
    const storage = unwrap(MemoryStorage.create());

    expect(
      await commitMemoryStorageRecords(storage, event(1), {
        ...snapshot(1),
        ...invalid,
      } as never),
    ).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule },
    });
    expect(
      unwrap(await inspectMemoryStorageRecords(storage)).records.size,
    ).toBe(0);
  });

  test("copies bytes and metadata before waiting and protects saved values from observation changes", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = commitMemoryStorageRecords(
      storage,
      event(1),
      snapshot(1),
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    await entered.promise;
    const input = {
      aggregateId: { typeName: "Order", value: "1" },
      seqNr: 2,
      occurredAt: new Date(occurredAt),
      manifest: "original-event",
      payload: Buffer.from([2, 3]),
    };
    const inputSnapshot = {
      seqNr: 2,
      manifest: "original-snapshot",
      aggregate: Buffer.from([4, 5]),
    };
    const queued = commitMemoryStorageRecords(storage, input, inputSnapshot);
    try {
      input.aggregateId.typeName = "Changed";
      input.aggregateId.value = "different";
      input.seqNr = 99;
      input.occurredAt.setTime(0);
      input.manifest = "changed-event";
      input.payload.fill(99);
      inputSnapshot.seqNr = 99;
      inputSnapshot.manifest = "changed-snapshot";
      inputSnapshot.aggregate.fill(99);
    } finally {
      release.resolve();
    }
    unwrap(await first);
    unwrap(await queued);
    const before = unwrap(await inspectMemoryStorageRecords(storage));
    const observed = unwrap(await inspectMemoryStorageRecords(storage));
    const record = observed.records.get("Order-1");
    if (record === undefined || record.snapshot === undefined) {
      throw new Error("expected committed records");
    }
    expect(record.head).toEqual({
      aggregateId: "Order-1",
      seqNr: 2,
      occurredAt,
      manifest: "original-event",
      payload: Uint8Array.of(2, 3),
    });
    expect(record.snapshot).toEqual({
      seqNr: 2,
      manifest: "original-snapshot",
      aggregate: Uint8Array.of(4, 5),
    });
    expect(record.history).toEqual([
      {
        seqNr: 2,
        manifest: "original-snapshot",
        aggregate: Uint8Array.of(4, 5),
      },
    ]);
    record.head.payload.fill(88);
    for (const saved of record.events) saved.payload.fill(88);
    record.snapshot.aggregate.fill(88);
    for (const saved of record.history) saved.aggregate.fill(88);
    expect(Reflect.set(record.head, "seqNr", 99)).toBe(false);
    expect(Reflect.set(record.snapshot, "manifest", "changed")).toBe(false);
    (observed.records as Map<string, unknown>).clear();

    expect(unwrap(await inspectMemoryStorageRecords(storage))).toEqual(before);
  });

  test("rejects unregistered handles without creating a destination", async () => {
    const storage = {} as MemoryStorage;

    expect(await commitMemoryStorageRecords(storage, event(1))).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(await inspectMemoryStorageRecords(storage)).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });
});
