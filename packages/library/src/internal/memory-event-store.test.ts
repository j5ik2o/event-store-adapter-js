import type { AggregateId } from "../aggregate-id";
import type { ContractRule } from "../contract-rule";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import * as memoryStorageModule from "../memory-storage";
import { MemoryStorage } from "../memory-storage";
import { PayloadSerializer } from "../payload-serializer";
import { Result } from "../result";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { createMemoryEventStoreInternal } from "./memory-event-store";
import * as memoryStorageRecords from "./memory-storage-records";
import {
  commitMemoryStorageRecords,
  inspectMemoryStorageRecords,
  readMemoryStorageEvents,
  readMemoryStorageLatestSnapshot,
} from "./memory-storage-records";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message);
  return result.value;
}

const millis = Date.parse("2026-10-09T00:00:00.123Z");
const eventOf = (seqNr = 1): EventEnvelope => ({
  aggregateId: { typeName: "Order", value: "1" },
  seqNr,
  occurredAt: new Date(millis),
  manifest: "event/v1",
  payload: { item: "book", seqNr },
});
const snapshotOf = (seqNr = 1): SnapshotEnvelope => ({
  seqNr,
  manifest: "snapshot/v1",
  aggregate: { items: ["book"], seqNr },
});

async function recordsOf(storage: MemoryStorage) {
  return unwrap(await inspectMemoryStorageRecords(storage)).records;
}

function expectViolation<T>(
  result: Result<T, EventStoreError>,
  rule: ContractRule,
) {
  expect(result).toMatchObject({
    type: "err",
    error: { type: "contract-violation", rule },
  });
  if (result.type !== "err") throw new Error("expected violation");
  expect(result.error.message).toContain(rule);
}

describe("memory aggregate ID access", () => {
  const writes = ["persistEvent", "persistEventAndSnapshot"] as const;
  const operations = [
    ...writes,
    "getLatestSnapshotById",
    "getEventsByIdSinceSeqNr",
  ] as const;

  function callWithId(
    store: EventStore,
    operation: keyof EventStore,
    aggregateId: AggregateId,
  ): Promise<Result<unknown, EventStoreError>> {
    switch (operation) {
      case "persistEvent":
        return store.persistEvent({ ...eventOf(2), aggregateId });
      case "persistEventAndSnapshot":
        return store.persistEventAndSnapshot(
          { ...eventOf(2), aggregateId },
          snapshotOf(2),
        );
      case "getLatestSnapshotById":
        return store.getLatestSnapshotById(aggregateId);
      case "getEventsByIdSinceSeqNr":
        return store.getEventsByIdSinceSeqNr(aggregateId, 0);
    }
  }

  describe.each(operations)("%s", (operation) => {
    test.each([
      ["getter", "typeName"],
      ["getter", "value"],
      ["Proxy", "typeName"],
      ["Proxy", "value"],
    ] as const)(
      "returns T-2 with the original cause when %s %s access throws",
      async (access, property) => {
        const storage = unwrap(
          MemoryStorage.create({ retention: { count: 1 } }),
        );
        const json = PayloadSerializer.json();
        const serializeEvent = jest.fn(json.serialize);
        const deserializeEvent = jest.fn(json.deserialize);
        const serializeSnapshot = jest.fn(json.serialize);
        const deserializeSnapshot = jest.fn(json.deserialize);
        const store = unwrap(
          createMemoryEventStoreInternal({
            storage,
            eventSerializer: {
              serialize: serializeEvent,
              deserialize: deserializeEvent,
            },
            snapshotSerializer: {
              serialize: serializeSnapshot,
              deserialize: deserializeSnapshot,
            },
          }),
        );
        unwrap(await store.persistEventAndSnapshot(eventOf(), snapshotOf()));
        const before = await recordsOf(storage);
        expect(before.get("Order-1")).toMatchObject({
          head: { seqNr: 1 },
          events: [{ seqNr: 1 }],
          snapshot: { seqNr: 1 },
          history: [{ seqNr: 1 }],
        });
        serializeEvent.mockClear();
        serializeSnapshot.mockClear();

        const cause = new Error("ID element access failed");
        const typeNameAccess = jest.fn(() => {
          if (property === "typeName") throw cause;
          return "Order";
        });
        const valueAccess = jest.fn(() => {
          if (property === "value") throw cause;
          return "1";
        });
        const aggregateId =
          access === "getter"
            ? {
                get typeName() {
                  return typeNameAccess();
                },
                get value() {
                  return valueAccess();
                },
              }
            : new Proxy(
                { typeName: "Order", value: "1" },
                {
                  get(target, key, receiver) {
                    if (key === "typeName") return typeNameAccess();
                    if (key === "value") return valueAccess();
                    return Reflect.get(target, key, receiver);
                  },
                },
              );
        const readSnapshot = jest.spyOn(
          memoryStorageRecords,
          "readMemoryStorageLatestSnapshot",
        );
        const readEvents = jest.spyOn(
          memoryStorageRecords,
          "readMemoryStorageEvents",
        );
        const commit = jest.spyOn(
          memoryStorageRecords,
          "commitMemoryStorageRecords",
        );

        try {
          const result = await callWithId(store, operation, aggregateId);

          expectViolation(result, "T-2");
          if (result.type !== "err") throw new Error("expected ID error");
          expect(result.error.cause).toBe(cause);
          expect(typeNameAccess).toHaveBeenCalledTimes(1);
          expect(valueAccess).toHaveBeenCalledTimes(
            property === "typeName" ? 0 : 1,
          );
          expect(serializeEvent).not.toHaveBeenCalled();
          expect(deserializeEvent).not.toHaveBeenCalled();
          expect(serializeSnapshot).not.toHaveBeenCalled();
          expect(deserializeSnapshot).not.toHaveBeenCalled();
          expect(readSnapshot).not.toHaveBeenCalled();
          expect(readEvents).not.toHaveBeenCalled();
          expect(commit).not.toHaveBeenCalled();
          expect(await recordsOf(storage)).toEqual(before);
        } finally {
          readSnapshot.mockRestore();
          readEvents.mockRestore();
          commit.mockRestore();
        }
      },
    );
  });

  describe.each(writes)("%s", (operation) => {
    test("reads successful ID getters once and commits the checked values", async () => {
      const storage = unwrap(MemoryStorage.create());
      const store = unwrap(createMemoryEventStoreInternal({ storage }));
      unwrap(await store.persistEvent(eventOf()));
      const typeName = jest
        .fn()
        .mockReturnValueOnce("Order")
        .mockReturnValue("Changed");
      const value = jest.fn().mockReturnValueOnce("1").mockReturnValue("other");
      const aggregateId = {
        get typeName() {
          return typeName();
        },
        get value() {
          return value();
        },
      };

      unwrap(await callWithId(store, operation, aggregateId));

      expect(typeName).toHaveBeenCalledTimes(1);
      expect(value).toHaveBeenCalledTimes(1);
      const records = await recordsOf(storage);
      expect([...records.keys()]).toEqual(["Order-1"]);
      expect(records.get("Order-1")?.head).toEqual({
        aggregateId: "Order-1",
        seqNr: 2,
        occurredAt: millis,
        manifest: "event/v1",
        payload: PayloadSerializer.json().serialize(eventOf(2).payload),
      });
    });

    test.each([
      [-1, "T-9"],
      [0, "W-6"],
    ] as const)(
      "preserves seqNr=%s validation before throwing ID getters: %s",
      async (seqNr, rule) => {
        const store = unwrap(createMemoryEventStoreInternal());
        const read = jest.fn(() => {
          throw new Error("ID must not be read before event validation");
        });
        const event = {
          ...eventOf(seqNr),
          aggregateId: {
            get typeName() {
              return read();
            },
            get value() {
              return read();
            },
          },
        };

        const result = await (operation === "persistEvent"
          ? store.persistEvent(event)
          : store.persistEventAndSnapshot(event, snapshotOf(seqNr)));

        expectViolation(result, rule);
        expect(read).not.toHaveBeenCalled();
      },
    );
  });

  test("getEventsByIdSinceSeqNr checks ID access before an invalid start", async () => {
    const store = unwrap(createMemoryEventStoreInternal());
    const cause = new Error("cannot read ID value");
    const typeName = jest.fn(() => "Order");
    const value = jest.fn(() => {
      throw cause;
    });
    const aggregateId = {
      get typeName() {
        return typeName();
      },
      get value() {
        return value();
      },
    };

    const result = await store.getEventsByIdSinceSeqNr(aggregateId, -1);

    expectViolation(result, "T-2");
    if (result.type !== "err") throw new Error("expected ID error");
    expect(result.error.cause).toBe(cause);
    expect(typeName).toHaveBeenCalledTimes(1);
    expect(value).toHaveBeenCalledTimes(1);
  });
});

describe("createMemoryEventStoreInternal", () => {
  test("provides the four connected operations", () => {
    const store = unwrap(createMemoryEventStoreInternal());

    expect(Object.keys(store)).toEqual([
      "persistEvent",
      "persistEventAndSnapshot",
      "getLatestSnapshotById",
      "getEventsByIdSinceSeqNr",
    ]);
  });

  test.each([
    null,
    {},
    { serialize: () => Uint8Array.of(1) },
    { serialize: 1, deserialize: () => null },
  ])(
    "rejects invalid snapshotSerializer %p without defaulting",
    (serializer) => {
      expect(
        createMemoryEventStoreInternal({
          snapshotSerializer: serializer as never,
        }),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "snapshotSerializer" },
      });
    },
  );

  test.each([null, false, 0, "settings", []])(
    "rejects invalid input %p as a configuration error",
    (input) => {
      expect(createMemoryEventStoreInternal(input as never)).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "input" },
      });
    },
  );

  test.each([
    null,
    {},
    { serialize: () => Uint8Array.of(1) },
    { serialize: 1, deserialize: () => null },
  ])("rejects invalid eventSerializer %p without defaulting", (serializer) => {
    expect(
      createMemoryEventStoreInternal({ eventSerializer: serializer as never }),
    ).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "eventSerializer" },
    });
  });

  test("preserves a default storage creation dependency error without side effects and restores normal creation and append", async () => {
    const originalMemoryStorage = MemoryStorage;
    const cause = new Error("controlled storage creation failure");
    const error = EventStoreError.storage("storage creation failed", cause);
    const failure = Result.err(error);
    // 有効な既定設定では自然発生しないため、生成依存の戻り値を一度だけ制御する。
    const create = jest
      .fn(originalMemoryStorage.create)
      .mockReturnValueOnce(failure);
    const serializer = PayloadSerializer.json();
    const serialize = jest.fn(serializer.serialize);
    const deserialize = jest.fn(serializer.deserialize);
    const input = { eventSerializer: { serialize, deserialize } };
    const commit = jest.spyOn(
      memoryStorageRecords,
      "commitMemoryStorageRecords",
    );

    try {
      const replacement = jest.replaceProperty(
        memoryStorageModule,
        "MemoryStorage",
        { create },
      );
      try {
        const result = createMemoryEventStoreInternal(input);

        expect(result).toBe(failure);
        expect(result).toMatchObject({
          type: "err",
          error: { type: "storage-error" },
        });
        if (result.type !== "err")
          throw new Error("expected storage creation error");
        expect(result.error).toBe(error);
        expect(result.error.cause).toBe(cause);
        expect(create).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith();
        expect(serialize).not.toHaveBeenCalled();
        expect(deserialize).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
      } finally {
        replacement.restore();
      }

      expect(memoryStorageModule.MemoryStorage).toBe(originalMemoryStorage);
      const store = unwrap(createMemoryEventStoreInternal(input));
      unwrap(await store.persistEvent(eventOf()));
      unwrap(await store.persistEvent(eventOf(2)));

      expect(serialize).toHaveBeenCalledTimes(2);
      expect(commit).toHaveBeenCalledTimes(2);
      const storage = commit.mock.calls[0][0];
      expect(commit.mock.calls[1][0]).toBe(storage);
      const records = (await recordsOf(storage)).get("Order-1");
      expect(records?.head.seqNr).toBe(2);
      expect(records?.events.map((saved) => saved.seqNr)).toEqual([1, 2]);
    } finally {
      commit.mockRestore();
    }
  });

  test("omitting storage creates independent destinations", async () => {
    const first = unwrap(createMemoryEventStoreInternal());
    const second = unwrap(createMemoryEventStoreInternal({}));

    unwrap(await first.persistEvent(eventOf()));
    unwrap(await first.persistEvent(eventOf(2)));
    unwrap(await second.persistEvent(eventOf()));
    unwrap(await second.persistEvent(eventOf(2)));

    for (const store of [first, second]) {
      expect(await store.persistEvent(eventOf(2))).toMatchObject({
        type: "err",
        error: { type: "optimistic-lock-conflict", headSeqNr: 2 },
      });
    }
    unwrap(await first.persistEvent(eventOf(3)));
    expect(
      unwrap(await first.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([eventOf(), eventOf(2), eventOf(3)]);
    expect(
      unwrap(await second.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([eventOf(), eventOf(2)]);
  });
});

describe("memory getLatestSnapshotById real records", () => {
  test("observes missing, event-only, pair, and subsequent event-only commits on the same storage", async () => {
    const storage = unwrap(MemoryStorage.create());
    const json = PayloadSerializer.json();
    const deserializeEvent = jest.fn(json.deserialize);
    const deserializeSnapshot = jest.fn(json.deserialize);
    const store = unwrap(
      createMemoryEventStoreInternal({
        storage,
        eventSerializer: {
          serialize: json.serialize,
          deserialize: deserializeEvent,
        },
        snapshotSerializer: {
          serialize: json.serialize,
          deserialize: deserializeSnapshot,
        },
      }),
    );
    const aggregateId = eventOf().aggregateId;

    expect(
      unwrap(await store.getLatestSnapshotById(aggregateId)),
    ).toBeUndefined();
    expect(deserializeSnapshot).not.toHaveBeenCalled();
    unwrap(await store.persistEvent(eventOf()));
    expect(unwrap(await store.getLatestSnapshotById(aggregateId))).toEqual({
      headSeqNr: 1,
      snapshot: undefined,
    });
    expect(deserializeSnapshot).not.toHaveBeenCalled();

    unwrap(await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));
    const paired = unwrap(await store.getLatestSnapshotById(aggregateId));
    expect(paired).toEqual({ headSeqNr: 2, snapshot: snapshotOf(2) });
    unwrap(await store.persistEvent(eventOf(3)));
    expect(unwrap(await store.getLatestSnapshotById(aggregateId))).toEqual({
      headSeqNr: 3,
      snapshot: snapshotOf(2),
    });
    expect(paired).toEqual({ headSeqNr: 2, snapshot: snapshotOf(2) });
    expect(deserializeSnapshot.mock.calls).toEqual([
      [json.serialize(snapshotOf(2).aggregate), "snapshot/v1"],
      [json.serialize(snapshotOf(2).aggregate), "snapshot/v1"],
    ]);
    expect(deserializeEvent).not.toHaveBeenCalled();
    const records = (await recordsOf(storage)).get("Order-1");
    expect(records?.head).toEqual({
      aggregateId: "Order-1",
      seqNr: 3,
      occurredAt: millis,
      manifest: "event/v1",
      payload: json.serialize(eventOf(3).payload),
    });
    expect(records?.snapshot).toEqual({
      ...snapshotOf(2),
      aggregate: json.serialize(snapshotOf(2).aggregate),
    });
  });

  test("matches complete validated keys, including empty and UTF-8 boundary IDs, without caller stringification", async () => {
    const store = unwrap(createMemoryEventStoreInternal());
    const asString = jest.fn(() => "Order-10");
    const callerToString = jest.fn(() => "Other-1");
    const callerId = {
      typeName: "Order",
      value: "1",
      asString,
      toString: callerToString,
    };
    const ids: AggregateId[] = [
      callerId,
      { typeName: "Order", value: "10" },
      { typeName: "Order", value: "1-2" },
      { typeName: "Other", value: "1" },
      { typeName: "", value: "1" },
      { typeName: "EmptyValue", value: "" },
      { typeName: "", value: "" },
      { typeName: "型", value: "値".repeat(340) },
    ];
    for (const aggregateId of ids) {
      const snapshot = {
        ...snapshotOf(),
        aggregate: `${aggregateId.typeName}-${aggregateId.value}`,
      };
      unwrap(
        await store.persistEventAndSnapshot(
          { ...eventOf(), aggregateId },
          snapshot,
        ),
      );
    }

    for (const aggregateId of ids) {
      expect(unwrap(await store.getLatestSnapshotById(aggregateId))).toEqual({
        headSeqNr: 1,
        snapshot: {
          ...snapshotOf(),
          aggregate: `${aggregateId.typeName}-${aggregateId.value}`,
        },
      });
    }
    expect(
      unwrap(
        await store.getLatestSnapshotById({ typeName: "Order", value: "" }),
      ),
    ).toBeUndefined();
    expect(asString).not.toHaveBeenCalled();
    expect(callerToString).not.toHaveBeenCalled();
  });

  test.each([
    [undefined, "T-2"],
    [null, "T-2"],
    [{}, "T-2"],
    [{ typeName: 1, value: "1" }, "T-2"],
    [{ typeName: "Order", value: 1 }, "T-2"],
    [{ typeName: "Order-item", value: "1" }, "T-11"],
    [{ typeName: "型", value: `${"値".repeat(340)}a` }, "T-12"],
  ] as const)(
    "rejects %p with %s before storage acquisition even while its queue is held",
    async (aggregateId, rule) => {
      const storage = unwrap(MemoryStorage.create());
      const json = PayloadSerializer.json();
      const deserialize = jest.fn(json.deserialize);
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          snapshotSerializer: { serialize: json.serialize, deserialize },
        }),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocking = commitMemoryStorageRecords(
        storage,
        {
          ...eventOf(),
          payload: Uint8Array.of(1),
        },
        undefined,
        () => {
          entered.resolve();
          return release.promise;
        },
      );
      const read = jest.spyOn(
        memoryStorageRecords,
        "readMemoryStorageLatestSnapshot",
      );
      const completed = jest.fn();
      const reading = store
        .getLatestSnapshotById(aggregateId as AggregateId)
        .then((result) => {
          completed();
          return result;
        });
      try {
        await entered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(completed).toHaveBeenCalledTimes(1);
        expectViolation(await reading, rule);
        expect(read).not.toHaveBeenCalled();
        expect(deserialize).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([blocking, reading]);
        read.mockRestore();
      }
      unwrap(await blocking);
    },
  );

  test("fixes checked ID properties once before waiting on the storage queue", async () => {
    const storage = unwrap(MemoryStorage.create());
    const json = PayloadSerializer.json();
    const deserialize = jest.fn(json.deserialize);
    const store = unwrap(
      createMemoryEventStoreInternal({
        storage,
        snapshotSerializer: { serialize: json.serialize, deserialize },
      }),
    );
    unwrap(await store.persistEventAndSnapshot(eventOf(), snapshotOf()));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocking = commitMemoryStorageRecords(
      storage,
      {
        ...eventOf(),
        aggregateId: { typeName: "Blocker", value: "1" },
        payload: Uint8Array.of(1),
      },
      undefined,
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    let typeName = "Order";
    let value = "1";
    const typeNameGetter = jest.fn(() => typeName);
    const valueGetter = jest.fn(() => value);
    const input = {
      get typeName() {
        return typeNameGetter();
      },
      get value() {
        return valueGetter();
      },
    };
    const read = jest.spyOn(
      memoryStorageRecords,
      "readMemoryStorageLatestSnapshot",
    );
    const reading = store.getLatestSnapshotById(input);
    try {
      await entered.promise;
      typeName = "Changed";
      value = "other";
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(read).toHaveBeenCalledWith(storage, "Order-1", undefined);
      expect(read).toHaveBeenCalledTimes(1);
      expect(typeNameGetter).toHaveBeenCalledTimes(1);
      expect(valueGetter).toHaveBeenCalledTimes(1);
      expect(deserialize).not.toHaveBeenCalled();
      release.resolve();

      expect(unwrap(await reading)).toEqual({
        headSeqNr: 1,
        snapshot: snapshotOf(),
      });
      expect(typeNameGetter).toHaveBeenCalledTimes(1);
      expect(valueGetter).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.allSettled([blocking, reading]);
      read.mockRestore();
    }
    unwrap(await blocking);
  });

  test("shares committed snapshots while each entry owns its snapshot restoration", async () => {
    const storage = unwrap(MemoryStorage.create());
    const json = PayloadSerializer.json();
    const firstDeserialize = jest.fn((bytes: Uint8Array, manifest: string) => ({
      reader: "first",
      value: json.deserialize(bytes, manifest),
    }));
    const secondDeserialize = jest.fn(
      (bytes: Uint8Array, manifest: string) => ({
        reader: "second",
        value: json.deserialize(bytes, manifest),
      }),
    );
    const first = unwrap(
      createMemoryEventStoreInternal<unknown, unknown>({
        storage,
        snapshotSerializer: {
          serialize: json.serialize,
          deserialize: firstDeserialize,
        },
      }),
    );
    const second = unwrap(
      createMemoryEventStoreInternal<unknown, unknown>({
        storage,
        snapshotSerializer: {
          serialize: json.serialize,
          deserialize: secondDeserialize,
        },
      }),
    );
    unwrap(await first.persistEventAndSnapshot(eventOf(), snapshotOf()));
    expect(
      unwrap(await second.getLatestSnapshotById(eventOf().aggregateId)),
    ).toEqual({
      headSeqNr: 1,
      snapshot: {
        ...snapshotOf(),
        aggregate: { reader: "second", value: snapshotOf().aggregate },
      },
    });
    expect(firstDeserialize).not.toHaveBeenCalled();
    unwrap(await second.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));
    expect(
      unwrap(await first.getLatestSnapshotById(eventOf().aggregateId)),
    ).toEqual({
      headSeqNr: 2,
      snapshot: {
        ...snapshotOf(2),
        aggregate: { reader: "first", value: snapshotOf(2).aggregate },
      },
    });
    expect(firstDeserialize.mock.calls).toEqual([
      [json.serialize(snapshotOf(2).aggregate), "snapshot/v1"],
    ]);
    expect(secondDeserialize.mock.calls).toEqual([
      [json.serialize(snapshotOf().aggregate), "snapshot/v1"],
    ]);
  });

  test("isolates the same aid and its queue on a separate storage", async () => {
    const storage = unwrap(MemoryStorage.create());
    const first = unwrap(createMemoryEventStoreInternal({ storage }));
    const second = unwrap(
      createMemoryEventStoreInternal({
        storage: unwrap(MemoryStorage.create()),
      }),
    );
    unwrap(await first.persistEventAndSnapshot(eventOf(), snapshotOf()));
    expect(
      unwrap(await second.getLatestSnapshotById(eventOf().aggregateId)),
    ).toBeUndefined();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocking = commitMemoryStorageRecords(
      storage,
      {
        ...eventOf(2),
        payload: Uint8Array.of(2),
      },
      undefined,
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    const other = { ...snapshotOf(), aggregate: "other storage" };
    try {
      await entered.promise;
      unwrap(await second.persistEventAndSnapshot(eventOf(), other));
      expect(
        unwrap(await second.getLatestSnapshotById(eventOf().aggregateId)),
      ).toEqual({
        headSeqNr: 1,
        snapshot: other,
      });
    } finally {
      release.resolve();
      await Promise.allSettled([blocking]);
    }
    unwrap(await blocking);
    expect(
      unwrap(await first.getLatestSnapshotById(eventOf().aggregateId)),
    ).toEqual({
      headSeqNr: 2,
      snapshot: snapshotOf(),
    });
    expect(
      unwrap(await second.getLatestSnapshotById(eventOf().aggregateId)),
    ).toEqual({
      headSeqNr: 1,
      snapshot: other,
    });
  });

  test("waits for a real pair publication and restores its atomic head and snapshot outside the queue", async () => {
    const storage = unwrap(MemoryStorage.create());
    const writer = unwrap(createMemoryEventStoreInternal({ storage }));
    const json = PayloadSerializer.json();
    const thirdEntered = jest.fn();
    const deserialize = jest.fn((bytes: Uint8Array, manifest: string) => {
      // 復元器自身から、後続の実commitが同じqueueへ進入済みであることを観測する。
      expect(thirdEntered).toHaveBeenCalledTimes(1);
      return json.deserialize(bytes, manifest);
    });
    const reader = unwrap(
      createMemoryEventStoreInternal({
        storage,
        snapshotSerializer: { serialize: json.serialize, deserialize },
      }),
    );
    unwrap(await writer.persistEventAndSnapshot(eventOf(), snapshotOf()));
    const enteredSecond = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const enteredThird = Promise.withResolvers<void>();
    const releaseThird = Promise.withResolvers<void>();
    const originalCommit = commitMemoryStorageRecords;
    const commit = jest
      .spyOn(memoryStorageRecords, "commitMemoryStorageRecords")
      .mockImplementation(
        (destination, event, snapshot, beforeCommit, retention) =>
          originalCommit(
            destination,
            event,
            snapshot,
            async () => {
              await beforeCommit?.();
              if (event.seqNr === 2) {
                enteredSecond.resolve();
                await releaseSecond.promise;
              } else if (event.seqNr === 3) {
                thirdEntered();
                enteredThird.resolve();
                await releaseThird.promise;
              }
            },
            retention,
          ),
      );
    const writingSecond = writer.persistEventAndSnapshot(
      eventOf(2),
      snapshotOf(2),
    );
    const completed = jest.fn();
    const reading = reader
      .getLatestSnapshotById(eventOf().aggregateId)
      .then((result) => {
        completed();
        return result;
      });
    const writingThird = writer.persistEventAndSnapshot(
      eventOf(3),
      snapshotOf(3),
    );
    try {
      await enteredSecond.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).not.toHaveBeenCalled();
      expect(deserialize).not.toHaveBeenCalled();
      expect(thirdEntered).not.toHaveBeenCalled();
      releaseSecond.resolve();
      unwrap(await writingSecond);
      await enteredThird.promise;

      const captured = unwrap(await reading);
      expect(captured).toEqual({ headSeqNr: 2, snapshot: snapshotOf(2) });
      expect(deserialize.mock.calls).toEqual([
        [json.serialize(snapshotOf(2).aggregate), "snapshot/v1"],
      ]);
      releaseThird.resolve();
      unwrap(await writingThird);
      expect(
        unwrap(await reader.getLatestSnapshotById(eventOf().aggregateId)),
      ).toEqual({
        headSeqNr: 3,
        snapshot: snapshotOf(3),
      });
      expect(captured).toEqual({ headSeqNr: 2, snapshot: snapshotOf(2) });
    } finally {
      releaseSecond.resolve();
      releaseThird.resolve();
      await Promise.allSettled([writingSecond, reading, writingThird]);
      commit.mockRestore();
    }
  });

  test.each([false, true])(
    "keeps metadata and bytes independent of inputs, results, restoration and inspection (Buffer=%p)",
    async (useBuffer) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      const scratch = useBuffer
        ? Buffer.from([99, 4, 5, 99])
        : Uint8Array.of(99, 4, 5, 99);
      const bytes = scratch.subarray(1, 3);
      const eventBytes = Uint8Array.of(1, 2);
      const deserialize = jest.fn((input: Uint8Array) => {
        const aggregate = new Uint8Array(input);
        input.fill(0);
        return aggregate;
      });
      const store = unwrap(
        createMemoryEventStoreInternal<Uint8Array, Uint8Array>({
          storage,
          eventSerializer: {
            serialize: () => eventBytes,
            deserialize: (input) => new Uint8Array(input),
          },
          snapshotSerializer: { serialize: () => bytes, deserialize },
        }),
      );
      const event = {
        ...eventOf(),
        aggregateId: { ...eventOf().aggregateId },
        payload: Uint8Array.of(1, 2),
      };
      const snapshot = { ...snapshotOf(), aggregate: Uint8Array.of(4, 5) };
      unwrap(await store.persistEventAndSnapshot(event, snapshot));
      const before = await recordsOf(storage);
      event.aggregateId.typeName = "Changed";
      event.aggregateId.value = "other";
      event.seqNr = 99;
      event.occurredAt.setTime(NaN);
      event.manifest = "changed";
      event.payload.fill(99);
      snapshot.seqNr = 99;
      snapshot.manifest = "changed";
      snapshot.aggregate.fill(99);
      eventBytes.fill(99);
      scratch.fill(99);

      const result = unwrap(
        await store.getLatestSnapshotById(eventOf().aggregateId),
      );
      const expected = {
        headSeqNr: 1,
        snapshot: {
          seqNr: 1,
          manifest: "snapshot/v1",
          aggregate: Uint8Array.of(4, 5),
        },
      };
      expect(result).toEqual(expected);
      if (result === undefined || result.snapshot === undefined)
        throw new Error("expected snapshot");
      expect(Reflect.set(result, "headSeqNr", 99)).toBe(false);
      expect(Reflect.set(result.snapshot, "seqNr", 99)).toBe(false);
      expect(Reflect.set(result.snapshot, "manifest", "changed result")).toBe(
        false,
      );
      result.snapshot.aggregate.fill(88);
      expect(deserialize.mock.calls[0][0]).toEqual(Uint8Array.of(0, 0));

      const observed = await recordsOf(storage);
      const record = observed.get("Order-1");
      if (record === undefined || record.snapshot === undefined)
        throw new Error("expected stored snapshot");
      expect(record.head).toEqual({
        aggregateId: "Order-1",
        seqNr: 1,
        occurredAt: millis,
        manifest: "event/v1",
        payload: Uint8Array.of(1, 2),
      });
      expect(record.snapshot).toEqual(expected.snapshot);
      record.head.payload.fill(77);
      for (const saved of record.events) saved.payload.fill(77);
      record.snapshot.aggregate.fill(77);
      for (const saved of record.history) saved.aggregate.fill(77);
      (observed as Map<string, unknown>).clear();

      expect(await recordsOf(storage)).toEqual(before);
      expect(
        unwrap(await store.getLatestSnapshotById(eventOf().aggregateId)),
      ).toEqual(expected);
      expect(await recordsOf(storage)).toEqual(before);
    },
  );

  test("the storage snapshot reader returns independent bytes and immutable metadata", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    expect(
      unwrap(await readMemoryStorageLatestSnapshot(storage, "Order-1")),
    ).toBeUndefined();
    unwrap(await store.persistEvent(eventOf()));
    expect(
      unwrap(await readMemoryStorageLatestSnapshot(storage, "Order-1")),
    ).toEqual({ headSeqNr: 1, snapshot: undefined });
    unwrap(await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));
    const before = await recordsOf(storage);
    const result = unwrap(
      await readMemoryStorageLatestSnapshot(storage, "Order-1"),
    );
    expect(result).toEqual({
      headSeqNr: 2,
      snapshot: before.get("Order-1")?.snapshot,
    });
    if (result === undefined || result.snapshot === undefined)
      throw new Error("expected snapshot bytes");
    expect(Reflect.set(result, "headSeqNr", 99)).toBe(false);
    expect(Reflect.set(result.snapshot, "manifest", "changed")).toBe(false);
    result.snapshot.aggregate.fill(0);

    expect(await recordsOf(storage)).toEqual(before);
    expect(
      unwrap(await store.getLatestSnapshotById(eventOf().aggregateId)),
    ).toEqual({ headSeqNr: 2, snapshot: snapshotOf(2) });
  });

  test("uses the supplied non-JSON snapshot serializer for an arbitrary domain function", async () => {
    const aggregate = () => BigInt(37);
    const serialize = jest.fn((value: () => bigint) =>
      Uint8Array.of(Number(value())),
    );
    const deserialize = jest.fn((bytes: Uint8Array) => () => BigInt(bytes[0]));
    const deserializeEvent = jest.fn(() => null);
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(
      createMemoryEventStoreInternal<unknown, () => bigint>({
        storage,
        eventSerializer: {
          serialize: PayloadSerializer.json().serialize,
          deserialize: deserializeEvent,
        },
        snapshotSerializer: { serialize, deserialize },
      }),
    );
    const snapshot = { seqNr: 1, manifest: "opaque/function-値", aggregate };
    unwrap(await store.persistEventAndSnapshot(eventOf(), snapshot));

    const result = unwrap(
      await store.getLatestSnapshotById(eventOf().aggregateId),
    );
    expect(result).toMatchObject({
      headSeqNr: 1,
      snapshot: { seqNr: 1, manifest: snapshot.manifest },
    });
    expect(result?.snapshot?.aggregate()).toBe(BigInt(37));
    expect(serialize.mock.calls).toEqual([[aggregate]]);
    expect(deserialize.mock.calls).toEqual([
      [Uint8Array.of(37), snapshot.manifest],
    ]);
    expect(deserializeEvent).not.toHaveBeenCalled();
    expect((await recordsOf(storage)).get("Order-1")?.snapshot).toEqual({
      seqNr: 1,
      manifest: snapshot.manifest,
      aggregate: Uint8Array.of(37),
    });
  });

  test.each([
    new Error("cannot restore"),
    "cannot restore",
    42,
    null,
    undefined,
    { code: "failure" },
    Symbol("failure"),
    BigInt(1),
  ])(
    "classifies snapshot restoration failure %p and preserves the original cause",
    async (cause) => {
      const storage = unwrap(MemoryStorage.create());
      const json = PayloadSerializer.json();
      const deserialize = jest
        .fn(json.deserialize)
        .mockImplementationOnce(() => {
          throw cause;
        });
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          snapshotSerializer: { serialize: json.serialize, deserialize },
        }),
      );
      unwrap(await store.persistEventAndSnapshot(eventOf(), snapshotOf()));
      const before = await recordsOf(storage);

      const result = await store.getLatestSnapshotById(eventOf().aggregateId);
      expect(result).toMatchObject({
        type: "err",
        error: { type: "serialization-error", operation: "deserialize" },
      });
      if (result.type !== "err")
        throw new Error("expected deserialization error");
      expect(result.error.cause).toBe(cause);
      expect(result).not.toHaveProperty("value");
      expect(deserialize.mock.calls).toEqual([
        [json.serialize(snapshotOf().aggregate), "snapshot/v1"],
      ]);
      expect(await recordsOf(storage)).toEqual(before);
      expect(
        unwrap(await store.getLatestSnapshotById(eventOf().aggregateId)),
      ).toEqual({ headSeqNr: 1, snapshot: snapshotOf() });
    },
  );

  test("preserves a real snapshot storage read error without starting restoration", async () => {
    const deserialize = jest.fn(() => null);
    const store = unwrap(
      createMemoryEventStoreInternal({
        storage: {} as MemoryStorage,
        snapshotSerializer: { serialize: () => Uint8Array.of(1), deserialize },
      }),
    );
    const read = jest.spyOn(
      memoryStorageRecords,
      "readMemoryStorageLatestSnapshot",
    );
    try {
      const result = await store.getLatestSnapshotById(eventOf().aggregateId);
      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error", cause: expect.any(TypeError) },
      });
      expect(result).toBe(await read.mock.results[0].value);
      expect(deserialize).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});

describe("memory getEventsByIdSinceSeqNr real records", () => {
  test("restores all committed events in ascending order from an inclusive start with their real metadata and JSON payloads", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    const events = [1, 2, 3].map((seqNr) => ({
      ...eventOf(seqNr),
      occurredAt: new Date(millis + seqNr),
      manifest: seqNr === 1 ? "" : `event/v${seqNr}`,
      payload: { item: `book-${seqNr}`, seqNr },
    }));
    for (const event of events) unwrap(await store.persistEvent(event));

    for (const start of [0, 2, 4, Number.MAX_SAFE_INTEGER]) {
      expect(
        unwrap(
          await store.getEventsByIdSinceSeqNr(events[0].aggregateId, start),
        ),
      ).toEqual(events.filter((event) => event.seqNr >= start));
    }
    expect(
      unwrap(
        await store.getEventsByIdSinceSeqNr(
          { typeName: "Order", value: "missing" },
          0,
        ),
      ),
    ).toEqual([]);
  });

  test("matches the full validated aid and ignores caller stringification", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    for (const seqNr of [1, 2, 3]) {
      unwrap(await store.persistEvent(eventOf(seqNr)));
    }
    for (const aggregateId of [
      { typeName: "Order", value: "10" },
      { typeName: "Order", value: "1-2" },
      { typeName: "Other", value: "1" },
      { typeName: "", value: "1" },
      { typeName: "EmptyValue", value: "" },
      { typeName: "", value: "" },
      { typeName: "型", value: "値".repeat(340) },
    ]) {
      const event = { ...eventOf(), aggregateId };
      unwrap(await store.persistEvent(event));
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(aggregateId, 0)),
      ).toEqual([event]);
    }
    const asString = jest.fn(() => "Order-10");
    const callerToString = jest.fn(() => "Other-1");
    const aggregateId = {
      ...eventOf().aggregateId,
      asString,
      toString: callerToString,
    };

    expect(unwrap(await store.getEventsByIdSinceSeqNr(aggregateId, 0))).toEqual(
      [eventOf(), eventOf(2), eventOf(3)],
    );
    expect(asString).not.toHaveBeenCalled();
    expect(callerToString).not.toHaveBeenCalled();
    expect(
      unwrap(
        await store.getEventsByIdSinceSeqNr(
          { typeName: "Order", value: "" },
          0,
        ),
      ),
    ).toEqual([]);
  });

  test.each([
    [undefined, 0, "T-2"],
    [null, 0, "T-2"],
    [{}, 0, "T-2"],
    [{ typeName: 1, value: "1" }, 0, "T-2"],
    [{ typeName: "Order", value: 1 }, 0, "T-2"],
    [{ typeName: "Order-item", value: "1" }, 0, "T-11"],
    [{ typeName: "型", value: `${"値".repeat(340)}a` }, 0, "T-12"],
    [eventOf().aggregateId, undefined, "T-9"],
    [eventOf().aggregateId, null, "T-9"],
    [eventOf().aggregateId, -1, "T-9"],
    [eventOf().aggregateId, 1.5, "T-9"],
    [eventOf().aggregateId, NaN, "T-9"],
    [eventOf().aggregateId, Infinity, "T-9"],
    [eventOf().aggregateId, Number.MAX_SAFE_INTEGER + 1, "T-9"],
    [eventOf().aggregateId, "2", "T-9"],
    [eventOf().aggregateId, true, "T-9"],
    [eventOf().aggregateId, BigInt(2), "T-9"],
  ] as const)(
    "rejects id=%p start=%p with %s before acquisition and restoration",
    async (aggregateId, seqNr, rule) => {
      const storage = unwrap(MemoryStorage.create());
      const json = PayloadSerializer.json();
      const deserialize = jest.fn(json.deserialize);
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: { serialize: json.serialize, deserialize },
        }),
      );
      unwrap(await store.persistEvent(eventOf()));
      const read = jest.spyOn(memoryStorageRecords, "readMemoryStorageEvents");

      try {
        const result = await store.getEventsByIdSinceSeqNr(
          aggregateId as AggregateId,
          seqNr as number,
        );

        expectViolation(result, rule);
        expect(read).not.toHaveBeenCalled();
        expect(deserialize).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    },
  );

  test("does not restore payloads for a missing aid or a start beyond the tail", async () => {
    const storage = unwrap(MemoryStorage.create());
    const json = PayloadSerializer.json();
    const deserialize = jest.fn(json.deserialize);
    const store = unwrap(
      createMemoryEventStoreInternal({
        storage,
        eventSerializer: { serialize: json.serialize, deserialize },
      }),
    );
    unwrap(await store.persistEvent(eventOf()));

    for (const [aggregateId, start] of [
      [{ typeName: "Order", value: "missing" }, 0],
      [eventOf().aggregateId, 2],
    ] as const) {
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(aggregateId, start)),
      ).toEqual([]);
    }
    expect(deserialize).not.toHaveBeenCalled();
  });

  test("fixes checked ID properties and the start before waiting on the storage queue", async () => {
    const storage = unwrap(MemoryStorage.create());
    const json = PayloadSerializer.json();
    const deserialize = jest.fn(json.deserialize);
    const store = unwrap(
      createMemoryEventStoreInternal({
        storage,
        eventSerializer: { serialize: json.serialize, deserialize },
      }),
    );
    for (const seqNr of [1, 2, 3])
      unwrap(await store.persistEvent(eventOf(seqNr)));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocking = commitMemoryStorageRecords(
      storage,
      {
        ...eventOf(),
        aggregateId: { typeName: "Blocker", value: "1" },
        payload: Uint8Array.of(1),
      },
      undefined,
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    await entered.promise;
    let typeName = "Order";
    let value = "1";
    let start = 2;
    const typeNameGetter = jest.fn(() => typeName);
    const valueGetter = jest.fn(() => value);
    const startGetter = jest.fn(() => start);
    const input = {
      aggregateId: {
        get typeName() {
          return typeNameGetter();
        },
        get value() {
          return valueGetter();
        },
      },
      get seqNr() {
        return startGetter();
      },
    };
    const read = jest.spyOn(memoryStorageRecords, "readMemoryStorageEvents");
    const reading = store.getEventsByIdSinceSeqNr(
      input.aggregateId,
      input.seqNr,
    );
    try {
      typeName = "Changed";
      value = "other";
      start = Number.MAX_SAFE_INTEGER;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(read).toHaveBeenCalledWith(storage, "Order-1", 2, undefined);
      expect(deserialize).not.toHaveBeenCalled();
      release.resolve();

      expect(unwrap(await reading)).toEqual([eventOf(2), eventOf(3)]);
      expect(typeNameGetter).toHaveBeenCalledTimes(1);
      expect(valueGetter).toHaveBeenCalledTimes(1);
      expect(startGetter).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.allSettled([blocking, reading]);
      read.mockRestore();
    }
    unwrap(await blocking);
  });

  test("shares real records across entries while each entry owns its restoration", async () => {
    const storage = unwrap(MemoryStorage.create());
    const json = PayloadSerializer.json();
    const firstDeserialize = jest.fn((bytes: Uint8Array, manifest: string) => ({
      reader: "first",
      manifest,
      value: json.deserialize(bytes, manifest),
    }));
    const secondDeserialize = jest.fn(
      (bytes: Uint8Array, manifest: string) => ({
        reader: "second",
        manifest,
        value: json.deserialize(bytes, manifest),
      }),
    );
    const first = unwrap(
      createMemoryEventStoreInternal<unknown>({
        storage,
        eventSerializer: {
          serialize: json.serialize,
          deserialize: firstDeserialize,
        },
      }),
    );
    const second = unwrap(
      createMemoryEventStoreInternal<unknown>({
        storage,
        eventSerializer: {
          serialize: json.serialize,
          deserialize: secondDeserialize,
        },
      }),
    );
    unwrap(await first.persistEvent(eventOf()));

    expect(
      unwrap(await second.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([
      {
        ...eventOf(),
        payload: {
          reader: "second",
          manifest: "event/v1",
          value: eventOf().payload,
        },
      },
    ]);
    expect(firstDeserialize).not.toHaveBeenCalled();
    unwrap(await second.persistEvent(eventOf(2)));
    expect(
      unwrap(await first.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual(
      [eventOf(), eventOf(2)].map((event) => ({
        ...event,
        payload: {
          reader: "first",
          manifest: event.manifest,
          value: event.payload,
        },
      })),
    );
    expect(secondDeserialize).toHaveBeenCalledTimes(1);
    expect(firstDeserialize).toHaveBeenCalledTimes(2);
    expect(
      (await recordsOf(storage))
        .get("Order-1")
        ?.events.map((event) => event.payload),
    ).toEqual(
      [eventOf(), eventOf(2)].map((event) => json.serialize(event.payload)),
    );
  });

  test("isolates reads from separate storage with the same aid", async () => {
    const first = unwrap(
      createMemoryEventStoreInternal({
        storage: unwrap(MemoryStorage.create()),
      }),
    );
    const second = unwrap(
      createMemoryEventStoreInternal({
        storage: unwrap(MemoryStorage.create()),
      }),
    );
    unwrap(await first.persistEvent(eventOf()));
    expect(
      unwrap(await second.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([]);
    const other = { ...eventOf(), payload: "other destination" };
    unwrap(await second.persistEvent(other));
    unwrap(await first.persistEvent(eventOf(2)));

    expect(
      unwrap(await first.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([eventOf(), eventOf(2)]);
    expect(
      unwrap(await second.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([other]);
  });

  test("waits for a real asynchronous append, copies all records under the same lock, and restores outside that lock", async () => {
    const storage = unwrap(MemoryStorage.create());
    const writer = unwrap(createMemoryEventStoreInternal({ storage }));
    const json = PayloadSerializer.json();
    const thirdEntered = jest.fn();
    const deserialize = jest.fn((bytes: Uint8Array, manifest: string) => {
      // 後続の実追記が既に排他へ進めることを、復元器自身から観測する。
      expect(thirdEntered).toHaveBeenCalledTimes(1);
      return json.deserialize(bytes, manifest);
    });
    const reader = unwrap(
      createMemoryEventStoreInternal({
        storage,
        eventSerializer: { serialize: json.serialize, deserialize },
      }),
    );
    unwrap(await writer.persistEvent(eventOf()));
    const enteredSecond = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const enteredThird = Promise.withResolvers<void>();
    const releaseThird = Promise.withResolvers<void>();
    const originalCommit = commitMemoryStorageRecords;
    const commit = jest
      .spyOn(memoryStorageRecords, "commitMemoryStorageRecords")
      .mockImplementation(
        (destination, event, snapshot, beforeCommit, retention) =>
          originalCommit(
            destination,
            event,
            snapshot,
            async () => {
              await beforeCommit?.();
              if (event.seqNr === 2) {
                enteredSecond.resolve();
                await releaseSecond.promise;
              } else if (event.seqNr === 3) {
                thirdEntered();
                enteredThird.resolve();
                await releaseThird.promise;
              }
            },
            retention,
          ),
      );
    const writingSecond = writer.persistEvent(eventOf(2));
    await enteredSecond.promise;
    const completed = jest.fn();
    const reading = reader
      .getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)
      .then((result) => {
        completed();
        return result;
      });
    const writingThird = writer.persistEvent(eventOf(3));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).not.toHaveBeenCalled();
      expect(deserialize).not.toHaveBeenCalled();
      expect(thirdEntered).not.toHaveBeenCalled();
      releaseSecond.resolve();
      unwrap(await writingSecond);
      await enteredThird.promise;

      expect(unwrap(await reading)).toEqual([eventOf(), eventOf(2)]);
      expect(deserialize.mock.calls).toEqual([
        [json.serialize(eventOf().payload), "event/v1"],
        [json.serialize(eventOf(2).payload), "event/v1"],
      ]);
      releaseThird.resolve();
      unwrap(await writingThird);
      expect(
        unwrap(await reader.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
      ).toEqual([eventOf(), eventOf(2), eventOf(3)]);
    } finally {
      releaseSecond.resolve();
      releaseThird.resolve();
      await Promise.allSettled([writingSecond, reading, writingThird]);
      commit.mockRestore();
    }
  });

  test("keeps saved values independent of input ID, Date, bytes, returned results, and a mutating deserializer", async () => {
    const storage = unwrap(MemoryStorage.create());
    const events = [1, 2, 3].map((seqNr) => ({
      ...eventOf(seqNr),
      aggregateId: { typeName: "Order", value: "1" },
      payload: { item: "book", seqNr },
    }));
    const bytes = events.map((event) =>
      Buffer.from(JSON.stringify(event.payload)),
    );
    const json = PayloadSerializer.json();
    const store = unwrap(
      createMemoryEventStoreInternal({
        storage,
        eventSerializer: {
          serialize: (payload: { item: string; seqNr: number }) =>
            bytes[payload.seqNr - 1],
          deserialize: (input: Uint8Array, manifest: string) => {
            const payload = json.deserialize(input, manifest) as {
              item: string;
              seqNr: number;
            };
            input.fill(0);
            return payload;
          },
        },
      }),
    );
    for (const event of events) unwrap(await store.persistEvent(event));
    const before = await recordsOf(storage);
    for (const event of events) {
      event.aggregateId.typeName = "Changed";
      event.aggregateId.value = "other";
      event.occurredAt.setTime(NaN);
      event.payload.item = "changed";
    }
    for (const input of bytes) input.fill(99);
    const aggregateId = { typeName: "Order", value: "1" };

    const results = unwrap(await store.getEventsByIdSinceSeqNr(aggregateId, 0));
    expect(results).toEqual([eventOf(), eventOf(2), eventOf(3)]);
    aggregateId.value = "changed";
    results[0].occurredAt.setTime(NaN);
    results[0].payload.item = "changed result";
    results.splice(1);

    expect(await recordsOf(storage)).toEqual(before);
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([eventOf(), eventOf(2), eventOf(3)]);
    expect(await recordsOf(storage)).toEqual(before);
  });

  test("the storage reader returns independent bytes and metadata from real persisted records", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    for (const seqNr of [1, 2, 3])
      unwrap(await store.persistEvent(eventOf(seqNr)));
    const before = await recordsOf(storage);

    const records = unwrap(
      await readMemoryStorageEvents(storage, "Order-1", 2),
    );
    expect(records).toEqual(before.get("Order-1")?.events.slice(1));
    for (const record of records) record.payload.fill(0);
    records.splice(0);

    expect(await recordsOf(storage)).toEqual(before);
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([eventOf(), eventOf(2), eventOf(3)]);
  });

  test.each([
    new Error("cannot restore"),
    "cannot restore",
    42,
    null,
    undefined,
    { code: "failure" },
    Symbol("failure"),
    BigInt(1),
  ])(
    "classifies a second-event deserialization failure %p with the original cause and no partial success",
    async (cause) => {
      const storage = unwrap(MemoryStorage.create());
      const json = PayloadSerializer.json();
      const deserialize = jest
        .fn(json.deserialize)
        .mockImplementationOnce(json.deserialize)
        .mockImplementationOnce(() => {
          throw cause;
        });
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: { serialize: json.serialize, deserialize },
        }),
      );
      for (const seqNr of [1, 2, 3])
        unwrap(await store.persistEvent(eventOf(seqNr)));
      const before = await recordsOf(storage);

      const result = await store.getEventsByIdSinceSeqNr(
        eventOf().aggregateId,
        0,
      );

      expect(result).toMatchObject({
        type: "err",
        error: { type: "serialization-error", operation: "deserialize" },
      });
      if (result.type !== "err")
        throw new Error("expected deserialization error");
      expect(result.error.cause).toBe(cause);
      expect(result).not.toHaveProperty("value");
      expect(deserialize).toHaveBeenCalledTimes(2);
      expect(await recordsOf(storage)).toEqual(before);
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
      ).toEqual([eventOf(), eventOf(2), eventOf(3)]);
    },
  );

  test("preserves a real storage read error and does not start restoration", async () => {
    const deserialize = jest.fn(() => null);
    const store = unwrap(
      createMemoryEventStoreInternal({
        storage: {} as MemoryStorage,
        eventSerializer: { serialize: () => Uint8Array.of(1), deserialize },
      }),
    );
    const read = jest.spyOn(memoryStorageRecords, "readMemoryStorageEvents");
    try {
      const result = await store.getEventsByIdSinceSeqNr(
        eventOf().aggregateId,
        0,
      );

      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error", cause: expect.any(TypeError) },
      });
      expect(result).toBe(await read.mock.results[0].value);
      expect(deserialize).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});

describe("memory persistEvent real records", () => {
  test("creates seq1 and appends seq2 and seq3 with metadata separate from JSON bytes", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));

    for (const seqNr of [1, 2, 3]) {
      unwrap(await store.persistEvent(eventOf(seqNr)));
      const expected = Array.from({ length: seqNr }, (_, index) => ({
        aggregateId: "Order-1",
        seqNr: index + 1,
        occurredAt: millis,
        manifest: "event/v1",
        payload: new TextEncoder().encode(
          JSON.stringify({ item: "book", seqNr: index + 1 }),
        ),
      }));
      expect(await recordsOf(storage)).toEqual(
        new Map([
          [
            "Order-1",
            {
              head: expected[seqNr - 1],
              events: expected,
              snapshot: undefined,
              history: [],
            },
          ],
        ]),
      );
    }
  });

  test.each([
    [0, 0, "contract-violation", "W-6"],
    [0, 2, "contract-violation", "W-8"],
    [0, Number.MAX_SAFE_INTEGER, "contract-violation", "W-8"],
    [1, 1, "optimistic-lock-conflict", undefined],
    [2, 2, "optimistic-lock-conflict", undefined],
    [2, 1, "optimistic-lock-conflict", undefined],
    [1, 3, "contract-violation", "W-8"],
  ] as const)(
    "head=%s seqNr=%s returns %s without committing",
    async (headSeqNr, seqNr, type, rule) => {
      const storage = unwrap(MemoryStorage.create());
      const store = unwrap(createMemoryEventStoreInternal({ storage }));
      for (let n = 1; n <= headSeqNr; n += 1) {
        unwrap(await store.persistEvent(eventOf(n)));
      }
      const before = await recordsOf(storage);

      const result = await store.persistEvent(eventOf(seqNr));

      expect(result).toMatchObject({
        type: "err",
        error: {
          type,
          seqNr,
          ...(rule === undefined
            ? { aggregateId: "Order-1", headSeqNr }
            : { rule }),
        },
      });
      expect(await recordsOf(storage)).toEqual(before);
    },
  );

  test.each([
    [{ aggregateId: undefined }, "T-2"],
    [{ aggregateId: null }, "T-2"],
    [{ seqNr: undefined }, "T-2"],
    [{ seqNr: null }, "T-2"],
    [{ occurredAt: undefined }, "T-2"],
    [{ occurredAt: null }, "T-2"],
    [{ payload: undefined }, "T-2"],
    [{ manifest: null }, "T-2"],
    [{ manifest: false }, "T-2"],
    [{ manifest: 1 }, "T-2"],
    [{ manifest: {} }, "T-2"],
    [{ aggregateId: { typeName: 1, value: "1" } }, "T-2"],
    [{ aggregateId: { typeName: "Order", value: 1 } }, "T-2"],
    [{ seqNr: 0 }, "W-6"],
    [{ seqNr: -1 }, "T-9"],
    [{ seqNr: 1.5 }, "T-9"],
    [{ seqNr: NaN }, "T-9"],
    [{ seqNr: Infinity }, "T-9"],
    [{ seqNr: Number.MAX_SAFE_INTEGER + 1 }, "T-9"],
    [{ seqNr: "2" }, "T-9"],
    [{ seqNr: true }, "T-9"],
    [{ aggregateId: { typeName: "Order-item", value: "1" } }, "T-11"],
    [{ aggregateId: { typeName: "a", value: "b".repeat(1023) } }, "T-12"],
    [
      { aggregateId: { typeName: "型", value: `${"値".repeat(340)}a` } },
      "T-12",
    ],
    [{ occurredAt: new Date(-9223372036855) }, "T-13"],
    [{ occurredAt: new Date(9223372036855) }, "T-13"],
    [{ occurredAt: new Date(NaN) }, "T-13"],
    [{ occurredAt: 0 }, "T-13"],
    [{ occurredAt: "1970-01-01T00:00:00Z" }, "T-13"],
  ] as const)(
    "rejects %p with %s before serialization and leaves real records unchanged",
    async (invalid, rule) => {
      const storage = unwrap(MemoryStorage.create());
      const serialize = jest.fn(PayloadSerializer.json().serialize);
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: { serialize, deserialize: () => null },
        }),
      );
      unwrap(await store.persistEvent(eventOf()));
      const before = await recordsOf(storage);
      serialize.mockClear();

      const result = await store.persistEvent({
        ...eventOf(2),
        ...invalid,
      } as EventEnvelope);

      expectViolation(result, rule);
      expect(serialize).not.toHaveBeenCalled();
      expect(await recordsOf(storage)).toEqual(before);
    },
  );

  test.each([undefined, null])(
    "rejects an absent event %p before serialization",
    async (input) => {
      const storage = unwrap(MemoryStorage.create());
      const serialize = jest.fn(() => Uint8Array.of(1));
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: { serialize, deserialize: () => null },
        }),
      );

      expectViolation(await store.persistEvent(input as never), "T-2");
      expect(serialize).not.toHaveBeenCalled();
      expect((await recordsOf(storage)).size).toBe(0);
    },
  );

  test.each([
    { typeName: "a", value: "b".repeat(1022) },
    { typeName: "型", value: "値".repeat(340) },
  ])("accepts the UTF-8 1024 byte boundary %p", async (aggregateId) => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    const key = `${aggregateId.typeName}-${aggregateId.value}`;

    unwrap(await store.persistEvent({ ...eventOf(), aggregateId }));

    expect(Buffer.byteLength(key, "utf8")).toBe(1024);
    expect([...(await recordsOf(storage)).keys()]).toEqual([key]);
  });

  test.each([-9223372036854, 9223372036854])(
    "stores occurredAt boundary %s unchanged",
    async (occurredAt) => {
      const storage = unwrap(MemoryStorage.create());
      const store = unwrap(createMemoryEventStoreInternal({ storage }));

      unwrap(
        await store.persistEvent({
          ...eventOf(),
          occurredAt: new Date(occurredAt),
        }),
      );

      expect((await recordsOf(storage)).get("Order-1")?.head.occurredAt).toBe(
        occurredAt,
      );
    },
  );

  test("normalizes an omitted manifest and accepts a null payload at the real entry", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    const { manifest: _manifest, ...input } = { ...eventOf(), payload: null };

    unwrap(await store.persistEvent(input as EventEnvelope));

    expect(input).not.toHaveProperty("manifest");
    expect((await recordsOf(storage)).get("Order-1")?.head).toMatchObject({
      manifest: "",
      payload: new TextEncoder().encode("null"),
    });
  });

  test("uses full aggregate keys and ignores caller stringification", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    const asString = jest.fn(() => "unrelated");
    for (const value of ["1", "10", "1-2"]) {
      unwrap(
        await store.persistEvent({
          ...eventOf(),
          aggregateId: {
            typeName: "Order",
            value,
            asString,
          } as EventEnvelope["aggregateId"],
        }),
      );
    }
    unwrap(await store.persistEvent(eventOf(2)));

    const records = await recordsOf(storage);
    expect([...records.keys()]).toEqual(["Order-1", "Order-10", "Order-1-2"]);
    expect([...records.values()].map((record) => record.head.seqNr)).toEqual([
      2, 1, 1,
    ]);
    expect(asString).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "serialization failure commits nothing and allows retry (existing=%s)",
    async (existing) => {
      const storage = unwrap(MemoryStorage.create());
      const cause = new Error("serialization failed");
      const serialize = jest.fn(PayloadSerializer.json().serialize);
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: { serialize, deserialize: () => null },
        }),
      );
      if (existing) unwrap(await store.persistEvent(eventOf()));
      const before = await recordsOf(storage);
      const seqNr = existing ? 2 : 1;
      serialize.mockImplementationOnce(() => {
        throw cause;
      });

      const result = await store.persistEvent(eventOf(seqNr));

      expect(result).toMatchObject({
        type: "err",
        error: { type: "serialization-error", operation: "serialize", cause },
      });
      if (result.type !== "err")
        throw new Error("expected serialization error");
      expect(result.error.cause).toBe(cause);
      expect(await recordsOf(storage)).toEqual(before);
      unwrap(await store.persistEvent(eventOf(seqNr)));
      expect((await recordsOf(storage)).get("Order-1")?.head.seqNr).toBe(seqNr);
    },
  );

  test.each([BigInt(1), () => null, { nested: undefined }])(
    "default JSON failure for %p commits nothing",
    async (payload) => {
      const storage = unwrap(MemoryStorage.create());
      const store = unwrap(createMemoryEventStoreInternal({ storage }));
      unwrap(await store.persistEvent(eventOf()));
      const before = await recordsOf(storage);

      expect(
        await store.persistEvent({ ...eventOf(2), payload }),
      ).toMatchObject({
        type: "err",
        error: {
          type: "serialization-error",
          operation: "serialize",
          cause: expect.any(TypeError),
        },
      });
      expect(await recordsOf(storage)).toEqual(before);
      unwrap(await store.persistEvent(eventOf(2)));
    },
  );

  test.each([
    undefined,
    null,
    [1],
    new ArrayBuffer(1),
    Promise.resolve(Uint8Array.of(1)),
  ])(
    "rejects non-Uint8Array serializer output %p before commit",
    async (bytes) => {
      const storage = unwrap(MemoryStorage.create());
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: {
            serialize: () => bytes,
            deserialize: () => null,
          } as unknown as PayloadSerializer<unknown>,
        }),
      );

      expect(await store.persistEvent(eventOf())).toMatchObject({
        type: "err",
        error: {
          type: "serialization-error",
          operation: "serialize",
          cause: expect.any(TypeError),
        },
      });
      expect((await recordsOf(storage)).size).toBe(0);
    },
  );

  test("preserves a real commit storage error", async () => {
    const store = unwrap(
      createMemoryEventStoreInternal({ storage: {} as MemoryStorage }),
    );

    expect(await store.persistEvent(eventOf())).toMatchObject({
      type: "err",
      error: { type: "storage-error", cause: expect.any(TypeError) },
    });
  });

  test("stores sharing a destination keep their own payload serializers", async () => {
    const storage = unwrap(MemoryStorage.create());
    const first = unwrap(
      createMemoryEventStoreInternal<unknown>({
        storage,
        eventSerializer: {
          serialize: () => Uint8Array.of(11),
          deserialize: () => null,
        },
      }),
    );
    const second = unwrap(
      createMemoryEventStoreInternal<unknown>({
        storage,
        eventSerializer: {
          serialize: () => Uint8Array.of(22),
          deserialize: () => null,
        },
      }),
    );

    unwrap(await first.persistEvent(eventOf()));
    unwrap(await second.persistEvent(eventOf(2)));
    unwrap(await first.persistEvent(eventOf(3)));

    expect(
      (await recordsOf(storage))
        .get("Order-1")
        ?.events.map((saved) => [...saved.payload]),
    ).toEqual([[11], [22], [11]]);
  });

  test("separate destinations isolate the same aggregate", async () => {
    const firstStorage = unwrap(MemoryStorage.create());
    const secondStorage = unwrap(MemoryStorage.create());
    const first = unwrap(
      createMemoryEventStoreInternal({ storage: firstStorage }),
    );
    const second = unwrap(
      createMemoryEventStoreInternal({ storage: secondStorage }),
    );

    unwrap(await first.persistEvent(eventOf()));
    expect((await recordsOf(secondStorage)).size).toBe(0);
    unwrap(await second.persistEvent({ ...eventOf(), payload: "other" }));
    const other = await recordsOf(secondStorage);
    unwrap(await first.persistEvent(eventOf(2)));

    expect((await recordsOf(firstStorage)).get("Order-1")?.head.seqNr).toBe(2);
    expect(await recordsOf(secondStorage)).toEqual(other);
    expect(other.get("Order-1")?.head.payload).toEqual(
      new TextEncoder().encode('"other"'),
    );
  });

  test.each([false, true])(
    "parallel stores commit the same number once (existing=%s)",
    async (existing) => {
      const storage = unwrap(MemoryStorage.create());
      const first = unwrap(createMemoryEventStoreInternal({ storage }));
      const second = unwrap(createMemoryEventStoreInternal({ storage }));
      if (existing) unwrap(await first.persistEvent(eventOf()));
      const seqNr = existing ? 2 : 1;
      const attempts = [
        eventOf(seqNr),
        { ...eventOf(seqNr), payload: "other" },
      ];

      const results = await Promise.all([
        first.persistEvent(attempts[0]),
        second.persistEvent(attempts[1]),
      ]);

      expect(results.filter((result) => result.type === "ok")).toHaveLength(1);
      const errors = results.filter((result) => result.type === "err");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        error: { type: "optimistic-lock-conflict", seqNr, headSeqNr: seqNr },
      });
      const record = (await recordsOf(storage)).get("Order-1");
      const winner =
        attempts[results.findIndex((result) => result.type === "ok")];
      expect(record?.head).toMatchObject({
        seqNr,
        payload: new TextEncoder().encode(JSON.stringify(winner.payload)),
      });
      expect(record?.events.map((saved) => saved.seqNr)).toEqual(
        existing ? [1, 2] : [1],
      );
      expect(record?.snapshot).toBeUndefined();
    },
  );

  test("prepares metadata and bytes before the storage queue and keeps saved values independent after changes", async () => {
    const storage = unwrap(MemoryStorage.create());
    const bytes = Buffer.from([2, 3]);
    const serialize = jest.fn(() => bytes);
    const store = unwrap(
      createMemoryEventStoreInternal<unknown>({
        storage,
        eventSerializer: { serialize, deserialize: () => null },
      }),
    );
    unwrap(await store.persistEvent(eventOf()));
    const first = await recordsOf(storage);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocking = commitMemoryStorageRecords(
      storage,
      {
        ...eventOf(),
        aggregateId: { typeName: "Blocker", value: "1" },
        payload: Uint8Array.of(1),
      },
      undefined,
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    await entered.promise;
    const input = {
      aggregateId: { typeName: "Order", value: "1" },
      seqNr: 2,
      occurredAt: new Date(millis),
      manifest: "original",
      payload: { item: "book" },
    };
    serialize.mockClear();
    const queued = store.persistEvent(input);
    const observed = jest.fn();
    const reading = recordsOf(storage).then((records) => {
      observed();
      return records;
    });
    try {
      expect(serialize).toHaveBeenCalledWith(input.payload);
      expect(serialize).toHaveBeenCalledTimes(1);
      input.aggregateId.typeName = "Changed";
      input.aggregateId.value = "other";
      input.seqNr = 99;
      input.occurredAt.setTime(NaN);
      input.manifest = "changed";
      input.payload.item = "changed";
      bytes.fill(99);
      await Promise.resolve();
      expect(observed).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    unwrap(await blocking);
    unwrap(await queued);
    const before = await reading;
    const record = before.get("Order-1");
    expect(record?.events[0]).toEqual(first.get("Order-1")?.head);
    expect(record?.head).toEqual({
      aggregateId: "Order-1",
      seqNr: 2,
      occurredAt: millis,
      manifest: "original",
      payload: Uint8Array.of(2, 3),
    });
    input.occurredAt.setTime(0);
    input.payload.item = "changed again";
    bytes.fill(88);
    expect(await recordsOf(storage)).toEqual(before);
  });

  test("validation and serialization failures finish while the storage queue is held", async () => {
    const storage = unwrap(MemoryStorage.create());
    const cause = new Error("cannot serialize");
    const serialize = jest.fn(() => {
      throw cause;
    });
    const store = unwrap(
      createMemoryEventStoreInternal<unknown>({
        storage,
        eventSerializer: { serialize, deserialize: () => null },
      }),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocking = commitMemoryStorageRecords(
      storage,
      {
        ...eventOf(),
        payload: Uint8Array.of(1),
      },
      undefined,
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    await entered.promise;
    const invalid = jest.fn();
    const failed = jest.fn();
    const invalidResult = store.persistEvent(eventOf(0)).then((result) => {
      invalid(result);
      return result;
    });
    const failedResult = store.persistEvent(eventOf(2)).then((result) => {
      failed(result);
      return result;
    });
    try {
      await Promise.resolve();
      expect(invalid).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ rule: "W-6" }),
        }),
      );
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: "serialization-error",
            operation: "serialize",
            cause,
          }),
        }),
      );
      expect(serialize).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    unwrap(await blocking);
    expectViolation(await invalidResult, "W-6");
    expect((await failedResult).type).toBe("err");
    expect((await recordsOf(storage)).get("Order-1")?.events).toHaveLength(1);
  });
});

describe("memory persistEventAndSnapshot real records", () => {
  test.each([undefined, 1])(
    "commits seq1 then seq2 with real event reads and all records (retention count=%p)",
    async (count) => {
      const storage = unwrap(
        MemoryStorage.create(
          count === undefined ? undefined : { retention: { count } },
        ),
      );
      const json = PayloadSerializer.json();
      const serializeEvent = jest.fn(json.serialize);
      const serializeSnapshot = jest.fn(json.serialize);
      const deserializeSnapshot = jest.fn(json.deserialize);
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: {
            serialize: serializeEvent,
            deserialize: json.deserialize,
          },
          snapshotSerializer: {
            serialize: serializeSnapshot,
            deserialize: deserializeSnapshot,
          },
        }),
      );

      for (const seqNr of [1, 2]) {
        unwrap(
          await store.persistEventAndSnapshot(
            eventOf(seqNr),
            snapshotOf(seqNr),
          ),
        );
        const events = Array.from({ length: seqNr }, (_, index) =>
          eventOf(index + 1),
        );
        const savedEvents = events.map((event) => ({
          aggregateId: "Order-1",
          seqNr: event.seqNr,
          occurredAt: millis,
          manifest: event.manifest,
          payload: new TextEncoder().encode(JSON.stringify(event.payload)),
        }));
        const snapshots = events.map((event) => ({
          ...snapshotOf(event.seqNr),
          aggregate: new TextEncoder().encode(
            JSON.stringify(snapshotOf(event.seqNr).aggregate),
          ),
        }));

        expect(
          unwrap(await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
        ).toEqual(events);
        expect(await recordsOf(storage)).toEqual(
          new Map([
            [
              "Order-1",
              {
                head: savedEvents[seqNr - 1],
                events: savedEvents,
                snapshot: snapshots[seqNr - 1],
                history: count === undefined ? [] : snapshots.slice(-count),
              },
            ],
          ]),
        );
      }
      expect(serializeEvent.mock.calls).toEqual([
        [eventOf().payload],
        [eventOf(2).payload],
      ]);
      expect(serializeSnapshot.mock.calls).toEqual([
        [snapshotOf().aggregate],
        [snapshotOf(2).aggregate],
      ]);
      expect(deserializeSnapshot).not.toHaveBeenCalled();
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 2)),
      ).toEqual([eventOf(2)]);
    },
  );

  test("normalizes omitted manifests and stores null payloads without changing either input", async () => {
    const storage = unwrap(MemoryStorage.create());
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    const event = {
      aggregateId: eventOf().aggregateId,
      seqNr: 1,
      occurredAt: new Date(millis),
      payload: null,
    };
    const snapshot = { seqNr: 1, aggregate: null };

    unwrap(
      await store.persistEventAndSnapshot(
        event as EventEnvelope,
        snapshot as SnapshotEnvelope,
      ),
    );

    expect(event).not.toHaveProperty("manifest");
    expect(snapshot).not.toHaveProperty("manifest");
    expect((await recordsOf(storage)).get("Order-1")).toMatchObject({
      head: { manifest: "", payload: new TextEncoder().encode("null") },
      snapshot: {
        seqNr: 1,
        manifest: "",
        aggregate: new TextEncoder().encode("null"),
      },
      history: [],
    });
    expect(
      unwrap(await store.getEventsByIdSinceSeqNr(event.aggregateId, 0)),
    ).toEqual([{ ...event, manifest: "" }]);
  });

  test.each([
    [undefined, snapshotOf(2), "T-2"],
    [null, snapshotOf(2), "T-2"],
    [eventOf(2), undefined, "T-10"],
    [eventOf(2), null, "T-10"],
    [eventOf(0), snapshotOf(0), "W-6"],
    [{ ...eventOf(2), payload: undefined }, snapshotOf(2), "T-2"],
    [{ ...eventOf(2), aggregateId: undefined }, snapshotOf(2), "T-2"],
    [
      { ...eventOf(2), aggregateId: { typeName: "Order-item", value: "1" } },
      snapshotOf(2),
      "T-11",
    ],
    [
      {
        ...eventOf(2),
        aggregateId: { typeName: "Order", value: "x".repeat(1024) },
      },
      snapshotOf(2),
      "T-12",
    ],
    [{ ...eventOf(2), seqNr: -1 }, snapshotOf(2), "T-9"],
    [{ ...eventOf(2), occurredAt: new Date(NaN) }, snapshotOf(2), "T-13"],
    [{ ...eventOf(2), manifest: null }, snapshotOf(2), "T-2"],
    [eventOf(2), { ...snapshotOf(2), aggregate: undefined }, "T-10"],
    [eventOf(2), { ...snapshotOf(2), seqNr: undefined }, "T-10"],
    [eventOf(2), { ...snapshotOf(2), seqNr: -1 }, "T-9"],
    [eventOf(2), { ...snapshotOf(2), manifest: null }, "T-10"],
    [eventOf(2), snapshotOf(0), "W-9"],
    [eventOf(2), snapshotOf(1), "W-9"],
    [eventOf(2), snapshotOf(3), "W-9"],
  ] as const)(
    "rejects event=%p snapshot=%p with %s before serializers and commit",
    async (event, snapshot, rule) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      const json = PayloadSerializer.json();
      const serializeEvent = jest.fn(json.serialize);
      const serializeSnapshot = jest.fn(json.serialize);
      const store = unwrap(
        createMemoryEventStoreInternal({
          storage,
          eventSerializer: {
            serialize: serializeEvent,
            deserialize: json.deserialize,
          },
          snapshotSerializer: {
            serialize: serializeSnapshot,
            deserialize: json.deserialize,
          },
        }),
      );
      unwrap(await store.persistEventAndSnapshot(eventOf(), snapshotOf()));
      const before = await recordsOf(storage);
      serializeEvent.mockClear();
      serializeSnapshot.mockClear();
      const commit = jest.spyOn(
        memoryStorageRecords,
        "commitMemoryStorageRecords",
      );

      try {
        const result = await store.persistEventAndSnapshot(
          event as EventEnvelope,
          snapshot as SnapshotEnvelope,
        );

        expectViolation(result, rule);
        if (rule === "W-9")
          expect(result).toMatchObject({
            error: { seqNr: 2, snapshotSeqNr: snapshot?.seqNr },
          });
        expect(serializeEvent).not.toHaveBeenCalled();
        expect(serializeSnapshot).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(await recordsOf(storage)).toEqual(before);
      } finally {
        commit.mockRestore();
      }
    },
  );

  test.each([
    [0, 2, "contract-violation", "W-8"],
    [1, 1, "optimistic-lock-conflict", undefined],
    [2, 2, "optimistic-lock-conflict", undefined],
    [2, 1, "optimistic-lock-conflict", undefined],
    [1, 3, "contract-violation", "W-8"],
  ] as const)(
    "head=%s rejects seqNr=%s as %s before preparing publication",
    async (headSeqNr, seqNr, type, rule) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 2 } }));
      const store = unwrap(createMemoryEventStoreInternal({ storage }));
      for (let n = 1; n <= headSeqNr; n += 1)
        unwrap(await store.persistEventAndSnapshot(eventOf(n), snapshotOf(n)));
      const before = await recordsOf(storage);
      const beforeCommit = jest.fn();
      const originalCommit = commitMemoryStorageRecords;
      const commit = jest
        .spyOn(memoryStorageRecords, "commitMemoryStorageRecords")
        .mockImplementation(
          (destination, event, snapshot, _beforeCommit, retention) =>
            originalCommit(
              destination,
              event,
              snapshot,
              beforeCommit,
              retention,
            ),
        );
      try {
        const result = await store.persistEventAndSnapshot(
          eventOf(seqNr),
          snapshotOf(seqNr),
        );

        expect(result).toMatchObject({
          type: "err",
          error: {
            type,
            seqNr,
            ...(rule === undefined
              ? { aggregateId: "Order-1", headSeqNr }
              : { rule }),
          },
        });
        expect(beforeCommit).not.toHaveBeenCalled();
        expect(await recordsOf(storage)).toEqual(before);
      } finally {
        commit.mockRestore();
      }
    },
  );

  describe.each(["event", "snapshot"] as const)(
    "%s serialization",
    (target) => {
      test.each(["throw", "non-bytes", "detached"] as const)(
        "%s failure preserves all records and allows the same-number retry",
        async (failure) => {
          const storage = unwrap(
            MemoryStorage.create({ retention: { count: 1 } }),
          );
          const json = PayloadSerializer.json();
          const serializeEvent = jest.fn(json.serialize);
          const serializeSnapshot = jest.fn(json.serialize);
          const store = unwrap(
            createMemoryEventStoreInternal({
              storage,
              eventSerializer: {
                serialize: serializeEvent,
                deserialize: json.deserialize,
              },
              snapshotSerializer: {
                serialize: serializeSnapshot,
                deserialize: json.deserialize,
              },
            }),
          );
          unwrap(await store.persistEventAndSnapshot(eventOf(), snapshotOf()));
          const before = await recordsOf(storage);
          serializeEvent.mockClear();
          serializeSnapshot.mockClear();
          const serialize =
            target === "event" ? serializeEvent : serializeSnapshot;
          const cause = new Error("controlled serializer failure");
          if (failure === "throw")
            serialize.mockImplementationOnce(() => {
              throw cause;
            });
          else if (failure === "non-bytes")
            serialize.mockReturnValueOnce(undefined as never);
          else {
            const detached = Uint8Array.of(2);
            structuredClone(detached.buffer, { transfer: [detached.buffer] });
            serialize.mockReturnValueOnce(detached);
          }
          const commit = jest.spyOn(
            memoryStorageRecords,
            "commitMemoryStorageRecords",
          );
          try {
            const result = await store.persistEventAndSnapshot(
              eventOf(2),
              snapshotOf(2),
            );

            expect(result).toMatchObject({
              type: "err",
              error: { type: "serialization-error", operation: "serialize" },
            });
            if (result.type !== "err")
              throw new Error("expected serialization error");
            if (failure === "throw") expect(result.error.cause).toBe(cause);
            else
              expect(result.error.cause).toMatchObject({ name: "TypeError" });
            expect(serializeEvent).toHaveBeenCalledTimes(1);
            expect(serializeSnapshot).toHaveBeenCalledTimes(
              target === "event" ? 0 : 1,
            );
            expect(commit).not.toHaveBeenCalled();
            expect(await recordsOf(storage)).toEqual(before);
            unwrap(
              await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)),
            );
            const after = (await recordsOf(storage)).get("Order-1");
            expect(after?.head.seqNr).toBe(2);
            expect(after?.history.map((saved) => saved.seqNr)).toEqual([2]);
          } finally {
            commit.mockRestore();
          }
        },
      );
    },
  );

  test.each([undefined, 1])(
    "preparation failure keeps the previous commit and permits retry (retention count=%p)",
    async (count) => {
      const storage = unwrap(
        MemoryStorage.create(
          count === undefined ? undefined : { retention: { count } },
        ),
      );
      const store = unwrap(createMemoryEventStoreInternal({ storage }));
      unwrap(await store.persistEventAndSnapshot(eventOf(), snapshotOf()));
      const before = await recordsOf(storage);
      const cause = new Error("controlled preparation failure");
      const originalCommit = commitMemoryStorageRecords;
      const commit = jest
        .spyOn(memoryStorageRecords, "commitMemoryStorageRecords")
        .mockImplementation(
          (destination, event, snapshot, _beforeCommit, retention) =>
            originalCommit(
              destination,
              event,
              snapshot,
              () => {
                throw cause;
              },
              retention,
            ),
        );
      try {
        expect(
          await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)),
        ).toMatchObject({
          type: "err",
          error: { type: "storage-error", cause },
        });
        expect(await recordsOf(storage)).toEqual(before);
        expect(
          unwrap(await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
        ).toEqual([eventOf()]);
      } finally {
        commit.mockRestore();
      }
      unwrap(await store.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));
      const after = (await recordsOf(storage)).get("Order-1");
      expect(after?.head.seqNr).toBe(2);
      expect(after?.snapshot?.seqNr).toBe(2);
      expect(after?.history.map((saved) => saved.seqNr)).toEqual(
        count === undefined ? [] : [2],
      );
    },
  );

  test("event readers and independent record inspection wait for the whole second commit", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const store = unwrap(createMemoryEventStoreInternal({ storage }));
    unwrap(await store.persistEventAndSnapshot(eventOf(), snapshotOf()));
    const before = await recordsOf(storage);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalCommit = commitMemoryStorageRecords;
    const commit = jest
      .spyOn(memoryStorageRecords, "commitMemoryStorageRecords")
      .mockImplementation(
        (destination, event, snapshot, _beforeCommit, retention) =>
          originalCommit(
            destination,
            event,
            snapshot,
            () => {
              entered.resolve();
              return release.promise;
            },
            retention,
          ),
      );
    const writing = store.persistEventAndSnapshot(eventOf(2), snapshotOf(2));
    const eventRead = jest.fn();
    const recordRead = jest.fn();
    const reading = store
      .getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)
      .then((result) => {
        eventRead();
        return result;
      });
    const inspecting = recordsOf(storage).then((records) => {
      recordRead();
      return records;
    });
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(eventRead).not.toHaveBeenCalled();
      expect(recordRead).not.toHaveBeenCalled();
      expect(before.get("Order-1")?.head.seqNr).toBe(1);
      expect(before.get("Order-1")?.snapshot?.seqNr).toBe(1);
      expect(
        before.get("Order-1")?.history.map((saved) => saved.seqNr),
      ).toEqual([1]);
      release.resolve();

      unwrap(await writing);
      expect(unwrap(await reading)).toEqual([eventOf(), eventOf(2)]);
      const second = (await inspecting).get("Order-1");
      expect(second).toEqual({
        head: {
          aggregateId: "Order-1",
          seqNr: 2,
          occurredAt: millis,
          manifest: "event/v1",
          payload: new TextEncoder().encode(JSON.stringify(eventOf(2).payload)),
        },
        events: [
          ...(before.get("Order-1")?.events ?? []),
          {
            aggregateId: "Order-1",
            seqNr: 2,
            occurredAt: millis,
            manifest: "event/v1",
            payload: new TextEncoder().encode(
              JSON.stringify(eventOf(2).payload),
            ),
          },
        ],
        snapshot: {
          ...snapshotOf(2),
          aggregate: new TextEncoder().encode(
            JSON.stringify(snapshotOf(2).aggregate),
          ),
        },
        history: [
          {
            ...snapshotOf(2),
            aggregate: new TextEncoder().encode(
              JSON.stringify(snapshotOf(2).aggregate),
            ),
          },
        ],
      });
    } finally {
      release.resolve();
      await Promise.allSettled([writing, reading, inspecting]);
      commit.mockRestore();
    }
  });

  test.each([false, true])(
    "protects both results when serializers reuse scratch and callers mutate queued inputs, reads and observations (Buffer=%p)",
    async (useBuffer) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
      const scratch = useBuffer
        ? Buffer.from([99, 0, 0, 99])
        : Uint8Array.of(99, 0, 0, 99);
      const bytes = scratch.subarray(1, 3);
      const serializeEvent = jest.fn((payload: Uint8Array) => {
        bytes.set(payload);
        return bytes;
      });
      const serializeSnapshot = jest.fn((payload: Uint8Array) => {
        bytes.set(payload);
        return bytes;
      });
      const store = unwrap(
        createMemoryEventStoreInternal<Uint8Array, Uint8Array>({
          storage,
          eventSerializer: {
            serialize: serializeEvent,
            deserialize: (input) => {
              const value = new Uint8Array(input);
              input.fill(0);
              return value;
            },
          },
          snapshotSerializer: {
            serialize: serializeSnapshot,
            deserialize: (input) => new Uint8Array(input),
          },
        }),
      );
      unwrap(
        await store.persistEventAndSnapshot(
          { ...eventOf(), payload: Uint8Array.of(1, 2) },
          { ...snapshotOf(), aggregate: Uint8Array.of(1, 1) },
        ),
      );
      const first = await recordsOf(storage);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocking = commitMemoryStorageRecords(
        storage,
        {
          ...eventOf(),
          aggregateId: { typeName: "Blocker", value: "1" },
          payload: Uint8Array.of(1),
        },
        undefined,
        () => {
          entered.resolve();
          return release.promise;
        },
      );
      await entered.promise;
      const event = {
        aggregateId: { typeName: "Order", value: "1" },
        seqNr: 2,
        occurredAt: new Date(millis),
        manifest: "event/v2",
        payload: Uint8Array.of(2, 3),
      };
      const snapshot = {
        seqNr: 2,
        manifest: "snapshot/v2",
        aggregate: Uint8Array.of(4, 5),
      };
      serializeEvent.mockClear();
      serializeSnapshot.mockClear();
      const queued = store.persistEventAndSnapshot(event, snapshot);
      try {
        expect(serializeEvent).toHaveBeenCalledWith(event.payload);
        expect(serializeSnapshot).toHaveBeenCalledWith(snapshot.aggregate);
        expect(serializeEvent).toHaveBeenCalledTimes(1);
        expect(serializeSnapshot).toHaveBeenCalledTimes(1);
        event.aggregateId.typeName = "Changed";
        event.aggregateId.value = "other";
        event.seqNr = 99;
        event.occurredAt.setTime(NaN);
        event.manifest = "changed";
        event.payload.fill(99);
        snapshot.seqNr = 99;
        snapshot.manifest = "changed";
        snapshot.aggregate.fill(99);
        scratch.fill(99);
        release.resolve();
        unwrap(await blocking);
        unwrap(await queued);
      } finally {
        release.resolve();
        await Promise.allSettled([blocking, queued]);
      }
      const before = await recordsOf(storage);
      const observed = await recordsOf(storage);
      const record = observed.get("Order-1");
      if (record === undefined || record.snapshot === undefined)
        throw new Error("expected snapshot commit");
      expect(record.head).toEqual({
        aggregateId: "Order-1",
        seqNr: 2,
        occurredAt: millis,
        manifest: "event/v2",
        payload: Uint8Array.of(2, 3),
      });
      expect(record.snapshot).toEqual({
        seqNr: 2,
        manifest: "snapshot/v2",
        aggregate: Uint8Array.of(4, 5),
      });
      expect(record.events[0]).toEqual(first.get("Order-1")?.head);
      expect(record.history).toEqual([
        { seqNr: 2, manifest: "snapshot/v2", aggregate: Uint8Array.of(4, 5) },
      ]);
      const expectedEvents = [
        { ...eventOf(), payload: Uint8Array.of(1, 2) },
        { ...eventOf(2), manifest: "event/v2", payload: Uint8Array.of(2, 3) },
      ];
      const returned = unwrap(
        await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0),
      );
      expect(returned).toEqual(expectedEvents);
      returned[0].occurredAt.setTime(NaN);
      returned[0].payload.fill(88);
      returned.splice(1);
      record.head.payload.fill(88);
      for (const saved of record.events) saved.payload.fill(88);
      record.snapshot.aggregate.fill(88);
      for (const saved of record.history) saved.aggregate.fill(88);
      (observed as Map<string, unknown>).clear();
      expect(await recordsOf(storage)).toEqual(before);
      expect(
        unwrap(await store.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
      ).toEqual(expectedEvents);
    },
  );

  test("shared entries use their own event and snapshot serializers for alternating commits", async () => {
    const storage = unwrap(MemoryStorage.create({ retention: { count: 1 } }));
    const serializeFirstEvent = jest.fn(() => Uint8Array.of(11));
    const serializeFirstSnapshot = jest.fn(() => Uint8Array.of(111));
    const serializeSecondEvent = jest.fn(() => Uint8Array.of(22));
    const serializeSecondSnapshot = jest.fn(() => Uint8Array.of(222));
    const deserialize = (bytes: Uint8Array) => [...bytes];
    const first = unwrap(
      createMemoryEventStoreInternal<unknown, unknown>({
        storage,
        eventSerializer: { serialize: serializeFirstEvent, deserialize },
        snapshotSerializer: { serialize: serializeFirstSnapshot, deserialize },
      }),
    );
    const second = unwrap(
      createMemoryEventStoreInternal<unknown, unknown>({
        storage,
        eventSerializer: { serialize: serializeSecondEvent, deserialize },
        snapshotSerializer: { serialize: serializeSecondSnapshot, deserialize },
      }),
    );

    unwrap(await first.persistEventAndSnapshot(eventOf(), snapshotOf()));
    unwrap(await second.persistEventAndSnapshot(eventOf(2), snapshotOf(2)));
    expect(
      (await recordsOf(storage)).get("Order-1")?.snapshot?.aggregate,
    ).toEqual(Uint8Array.of(222));
    unwrap(await first.persistEventAndSnapshot(eventOf(3), snapshotOf(3)));

    const record = (await recordsOf(storage)).get("Order-1");
    expect(record?.events.map((event) => [...event.payload])).toEqual([
      [11],
      [22],
      [11],
    ]);
    expect(record?.history.map((snapshot) => [...snapshot.aggregate])).toEqual([
      [111],
    ]);
    expect(record?.snapshot?.aggregate).toEqual(Uint8Array.of(111));
    expect(
      unwrap(
        await second.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0),
      ).map((event) => event.payload),
    ).toEqual([[11], [22], [11]]);
    expect(serializeFirstEvent).toHaveBeenCalledTimes(2);
    expect(serializeFirstSnapshot).toHaveBeenCalledTimes(2);
    expect(serializeSecondEvent).toHaveBeenCalledTimes(1);
    expect(serializeSecondSnapshot).toHaveBeenCalledTimes(1);
  });

  test("separate destinations keep records and queues independent for the same aid", async () => {
    const firstStorage = unwrap(
      MemoryStorage.create({ retention: { count: 1 } }),
    );
    const secondStorage = unwrap(MemoryStorage.create());
    const first = unwrap(
      createMemoryEventStoreInternal({ storage: firstStorage }),
    );
    const second = unwrap(
      createMemoryEventStoreInternal({ storage: secondStorage }),
    );
    unwrap(await first.persistEventAndSnapshot(eventOf(), snapshotOf()));
    expect((await recordsOf(secondStorage)).size).toBe(0);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalCommit = commitMemoryStorageRecords;
    const commit = jest
      .spyOn(memoryStorageRecords, "commitMemoryStorageRecords")
      .mockImplementation((storage, event, snapshot, beforeCommit, retention) =>
        originalCommit(
          storage,
          event,
          snapshot,
          storage === firstStorage
            ? () => {
                entered.resolve();
                return release.promise;
              }
            : beforeCommit,
          retention,
        ),
      );
    const pending = first.persistEventAndSnapshot(eventOf(2), snapshotOf(2));
    const otherEvent = { ...eventOf(), payload: "other event" };
    const otherSnapshot = { ...snapshotOf(), aggregate: "other snapshot" };
    try {
      await entered.promise;
      unwrap(await second.persistEventAndSnapshot(otherEvent, otherSnapshot));
      expect(
        unwrap(await second.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
      ).toEqual([otherEvent]);
      expect((await recordsOf(secondStorage)).get("Order-1")).toMatchObject({
        head: { seqNr: 1 },
        snapshot: {
          seqNr: 1,
          aggregate: new TextEncoder().encode('"other snapshot"'),
        },
        history: [],
      });
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      commit.mockRestore();
    }
    unwrap(await pending);
    expect(
      (await recordsOf(firstStorage))
        .get("Order-1")
        ?.history.map((snapshot) => snapshot.seqNr),
    ).toEqual([2]);
    expect(
      unwrap(await second.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
    ).toEqual([otherEvent]);
  });

  test.each([false, true])(
    "parallel shared entries commit one complete event and snapshot pair (existing=%p)",
    async (existing) => {
      const storage = unwrap(MemoryStorage.create({ retention: { count: 2 } }));
      const first = unwrap(createMemoryEventStoreInternal({ storage }));
      const second = unwrap(createMemoryEventStoreInternal({ storage }));
      if (existing)
        unwrap(await first.persistEventAndSnapshot(eventOf(), snapshotOf()));
      const before = await recordsOf(storage);
      const seqNr = existing ? 2 : 1;
      const attempts = [
        {
          event: { ...eventOf(seqNr), payload: "first event" },
          snapshot: { ...snapshotOf(seqNr), aggregate: "first snapshot" },
        },
        {
          event: { ...eventOf(seqNr), payload: "second event" },
          snapshot: { ...snapshotOf(seqNr), aggregate: "second snapshot" },
        },
      ];

      const results = await Promise.all([
        first.persistEventAndSnapshot(attempts[0].event, attempts[0].snapshot),
        second.persistEventAndSnapshot(attempts[1].event, attempts[1].snapshot),
      ]);

      expect(results.filter((result) => result.type === "ok")).toHaveLength(1);
      const errors = results.filter((result) => result.type === "err");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        error: {
          type: "optimistic-lock-conflict",
          aggregateId: "Order-1",
          seqNr,
          headSeqNr: seqNr,
        },
      });
      const winner =
        attempts[results.findIndex((result) => result.type === "ok")];
      const savedEvent = {
        aggregateId: "Order-1",
        seqNr,
        occurredAt: millis,
        manifest: winner.event.manifest,
        payload: new TextEncoder().encode(JSON.stringify(winner.event.payload)),
      };
      const savedSnapshot = {
        ...winner.snapshot,
        aggregate: new TextEncoder().encode(
          JSON.stringify(winner.snapshot.aggregate),
        ),
      };
      expect((await recordsOf(storage)).get("Order-1")).toEqual({
        head: savedEvent,
        events: [...(before.get("Order-1")?.events ?? []), savedEvent],
        snapshot: savedSnapshot,
        history: [...(before.get("Order-1")?.history ?? []), savedSnapshot],
      });
      expect(
        unwrap(await first.getEventsByIdSinceSeqNr(eventOf().aggregateId, 0)),
      ).toEqual(existing ? [eventOf(), winner.event] : [winner.event]);
    },
  );
});
