import type { Result } from "../../result";
import type { ContractRule } from "../contract-rule";
import type { EventEnvelope } from "../event-envelope";
import type { EventStoreError } from "../event-store-error";
import { MemoryStorage } from "../memory-storage";
import { PayloadSerializer } from "../payload-serializer";
import { createMemoryEventStoreInternal } from "./memory-event-store";
import {
  commitMemoryStorageRecords,
  inspectMemoryStorageRecords,
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

async function recordsOf(storage: MemoryStorage) {
  return unwrap(await inspectMemoryStorageRecords(storage)).records;
}

function expectViolation(
  result: Result<void, EventStoreError>,
  rule: ContractRule,
) {
  expect(result).toMatchObject({
    type: "err",
    error: { type: "contract-violation", rule },
  });
  if (result.type !== "err") throw new Error("expected violation");
  expect(result.error.message).toContain(rule);
}

describe("createMemoryEventStoreInternal", () => {
  test("provides only persistEvent", () => {
    const store = unwrap(createMemoryEventStoreInternal());

    expect(Object.keys(store)).toEqual(["persistEvent"]);
  });

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
