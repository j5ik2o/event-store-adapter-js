import { Result } from "../../result";
import type { AggregateId } from "../aggregate-id";
import type { ContractRule } from "../contract-rule";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import type { LatestSnapshot } from "../latest-snapshot";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { createValidatedEventStore } from "./validated-event-store";

const aggregateId = { typeName: "Order", value: "1" };
const eventOf = (seqNr = 1): EventEnvelope => ({
  aggregateId,
  seqNr,
  occurredAt: new Date(0),
  manifest: "event/v1",
  payload: { item: "book" },
});
const snapshotOf = (seqNr = 1): SnapshotEnvelope => ({
  seqNr,
  manifest: "snapshot/v1",
  aggregate: { items: ["book"] },
});

function createTarget<PE = unknown, PS = unknown>() {
  return {
    persistEvent: jest
      .fn<
        ReturnType<EventStore<PE, PS>["persistEvent"]>,
        Parameters<EventStore<PE, PS>["persistEvent"]>
      >()
      .mockResolvedValue(Result.ok(undefined)),
    persistEventAndSnapshot: jest
      .fn<
        ReturnType<EventStore<PE, PS>["persistEventAndSnapshot"]>,
        Parameters<EventStore<PE, PS>["persistEventAndSnapshot"]>
      >()
      .mockResolvedValue(Result.ok(undefined)),
    getLatestSnapshotById: jest
      .fn<
        ReturnType<EventStore<PE, PS>["getLatestSnapshotById"]>,
        Parameters<EventStore<PE, PS>["getLatestSnapshotById"]>
      >()
      .mockResolvedValue(Result.ok(undefined)),
    getEventsByIdSinceSeqNr: jest
      .fn<
        ReturnType<EventStore<PE, PS>["getEventsByIdSinceSeqNr"]>,
        Parameters<EventStore<PE, PS>["getEventsByIdSinceSeqNr"]>
      >()
      .mockResolvedValue(Result.ok([])),
  };
}

function expectNoCalls(target: jest.Mocked<EventStore>) {
  for (const method of Object.values(target)) {
    expect(method).not.toHaveBeenCalled();
  }
}

function expectOnlyCall(
  target: jest.Mocked<EventStore>,
  operation: keyof EventStore,
) {
  for (const name of operations) {
    expect(target[name]).toHaveBeenCalledTimes(name === operation ? 1 : 0);
  }
}

function expectViolation(
  result: Result<unknown, EventStoreError>,
  rule: ContractRule,
) {
  expect(result.type).toBe("err");
  if (result.type !== "err") throw new Error("expected err");
  expect(result.error).toMatchObject({ type: "contract-violation", rule });
  expect(result.error.message).toContain(rule);
  return result.error;
}

const writes = ["persistEvent", "persistEventAndSnapshot"] as const;
const operations = [
  ...writes,
  "getLatestSnapshotById",
  "getEventsByIdSinceSeqNr",
] as const;

function callWrite(
  store: EventStore,
  operation: (typeof writes)[number],
  event: EventEnvelope,
  snapshot: SnapshotEnvelope,
) {
  return operation === "persistEvent"
    ? store.persistEvent(event)
    : store.persistEventAndSnapshot(event, snapshot);
}

function callWithId(
  store: EventStore,
  operation: keyof EventStore,
  id: AggregateId,
) {
  switch (operation) {
    case "persistEvent":
      return store.persistEvent({ ...eventOf(), aggregateId: id });
    case "persistEventAndSnapshot":
      return store.persistEventAndSnapshot(
        { ...eventOf(), aggregateId: id },
        snapshotOf(),
      );
    case "getLatestSnapshotById":
      return store.getLatestSnapshotById(id);
    case "getEventsByIdSinceSeqNr":
      return store.getEventsByIdSinceSeqNr(id, 0);
  }
}

describe.each(writes)("%s event validation", (operation) => {
  test.each([1, 2, Number.MAX_SAFE_INTEGER])(
    "delegates seqNr %s without consulting a head",
    async (seqNr) => {
      const target = createTarget();
      const store = createValidatedEventStore(target);
      const event = eventOf(seqNr);
      const snapshot = snapshotOf(seqNr);

      const result = await callWrite(store, operation, event, snapshot);

      expect(result).toEqual(Result.ok(undefined));
      if (operation === "persistEvent") {
        expect(target.persistEvent).toHaveBeenCalledWith(event);
      } else {
        expect(target.persistEventAndSnapshot).toHaveBeenCalledWith(
          event,
          snapshot,
        );
      }
      expectOnlyCall(target, operation);
    },
  );

  test.each([null, false, 0, ""])(
    "accepts payload %p and normalizes an omitted manifest without changing input",
    async (payload) => {
      const target = createTarget();
      const store = createValidatedEventStore(target);
      const { manifest: _manifest, ...input } = { ...eventOf(), payload };
      const event = Object.freeze(input);
      const snapshot = Object.freeze({ seqNr: 1, aggregate: null });

      const result = await callWrite(
        store,
        operation,
        event as EventEnvelope,
        snapshot as SnapshotEnvelope,
      );

      expect(result).toEqual(Result.ok(undefined));
      if (operation === "persistEvent") {
        expect(target.persistEvent).toHaveBeenCalledWith({
          ...event,
          manifest: "",
        });
      } else {
        expect(target.persistEventAndSnapshot).toHaveBeenCalledWith(
          { ...event, manifest: "" },
          { ...snapshot, manifest: "" },
        );
      }
      expect(event).not.toHaveProperty("manifest");
      expect(snapshot).not.toHaveProperty("manifest");
      expectOnlyCall(target, operation);
    },
  );

  describe("caller property snapshot", () => {
    test.each(["aggregateId", "seqNr", "occurredAt", "manifest", "payload"])(
      "delegates the first event %s getter value",
      async (key) => {
        const target = createTarget();
        const store = createValidatedEventStore(target);
        const first = eventOf();
        const getters = Object.fromEntries(
          Object.entries(first).map(([name, value]) => [
            name,
            jest
              .fn()
              .mockReturnValueOnce(value)
              .mockReturnValue(name === key ? undefined : value),
          ]),
        );
        const event = Object.defineProperties(
          {},
          Object.fromEntries(
            Object.entries(getters).map(([name, get]) => [name, { get }]),
          ),
        ) as EventEnvelope;

        const result = await callWrite(store, operation, event, snapshotOf());

        expect(result).toEqual(Result.ok(undefined));
        expectOnlyCall(target, operation);
        const delegated = target[operation].mock.calls[0][0];
        expect(delegated).toEqual(first);
        expect(delegated.payload).toBe(first.payload);
        for (const getter of Object.values(getters)) {
          expect(getter).toHaveBeenCalledTimes(1);
        }
      },
    );

    test.each(["aggregateId", "seqNr", "occurredAt", "payload"])(
      "rejects a first missing event %s getter value before any target call",
      async (key) => {
        const target = createTarget();
        const store = createValidatedEventStore(target);
        const values = eventOf(7);
        const getters = Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            jest
              .fn()
              .mockReturnValueOnce(name === key ? undefined : value)
              .mockReturnValue(value),
          ]),
        );
        const event = Object.defineProperties(
          {},
          Object.fromEntries(
            Object.entries(getters).map(([name, get]) => [name, { get }]),
          ),
        ) as EventEnvelope;

        const result = await callWrite(store, operation, event, snapshotOf(7));

        const error = expectViolation(result, "T-2");
        if (key === "seqNr") {
          expect(error).not.toHaveProperty("seqNr");
          expect(error.message).not.toContain("seqNr=");
        } else {
          expect(error).toHaveProperty("seqNr", 7);
          expect(error.message).toContain("seqNr=7");
        }
        expectNoCalls(target);
        for (const getter of Object.values(getters)) {
          expect(getter).toHaveBeenCalledTimes(1);
        }
      },
    );
  });

  test.each([
    [{ payload: undefined, seqNr: -1, occurredAt: new Date(NaN) }, "T-2"],
    [{ seqNr: -1, occurredAt: new Date(NaN) }, "T-9"],
    [{ seqNr: 0, occurredAt: new Date(NaN) }, "W-6"],
    [
      {
        occurredAt: new Date(NaN),
        aggregateId: { typeName: "bad-id", value: "1" },
      },
      "T-13",
    ],
  ] as const)(
    "preserves event validation priority for %p: %s",
    async (input, rule) => {
      const target = createTarget();
      const store = createValidatedEventStore(target);

      const result = await callWrite(
        store,
        operation,
        { ...eventOf(), ...input } as EventEnvelope,
        snapshotOf(),
      );

      expectViolation(result, rule);
      expectNoCalls(target);
    },
  );

  describe.each(["aggregateId", "seqNr", "occurredAt", "payload"])(
    "required %s",
    (key) => {
      test.each(
        key === "payload"
          ? ["omitted", "undefined"]
          : ["omitted", "undefined", "null"],
      )("rejects %s with T-2 before any target call", async (kind) => {
        const target = createTarget();
        const store = createValidatedEventStore(target);
        const event =
          kind === "omitted"
            ? Object.fromEntries(
                Object.entries(eventOf()).filter(([name]) => name !== key),
              )
            : { ...eventOf(), [key]: kind === "null" ? null : undefined };

        const result = await callWrite(
          store,
          operation,
          event as EventEnvelope,
          snapshotOf(),
        );

        const error = expectViolation(result, "T-2");
        if (key === "seqNr") {
          expect(error).not.toHaveProperty("seqNr");
          expect(error.message).not.toContain("seqNr=");
        } else {
          expect(error).toHaveProperty("seqNr", 1);
          expect(error.message).toContain("seqNr=1");
        }
        expectNoCalls(target);
      });
    },
  );

  test.each([undefined, null])("rejects an absent event %p", async (input) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await callWrite(
      store,
      operation,
      input as unknown as EventEnvelope,
      snapshotOf(),
    );

    const error = expectViolation(result, "T-2");
    expect(error).not.toHaveProperty("seqNr");
    expectNoCalls(target);
  });

  test("rejects event seqNr 0 with W-6", async () => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await callWrite(store, operation, eventOf(0), snapshotOf(0));

    const error = expectViolation(result, "W-6");
    expect(error).toHaveProperty("seqNr", 0);
    expect(error.message).toContain("seqNr=0");
    expectNoCalls(target);
  });

  test.each([
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    "1",
    true,
    { toString: null, valueOf: null },
  ])("rejects event seqNr %p with T-9", async (seqNr) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await callWrite(
      store,
      operation,
      { ...eventOf(), seqNr } as EventEnvelope,
      snapshotOf(),
    );

    expectViolation(result, "T-9");
    expectNoCalls(target);
  });

  test.each([-9223372036854, 9223372036854])(
    "preserves valid occurredAt boundary %s",
    async (millis) => {
      const target = createTarget();
      const store = createValidatedEventStore(target);
      const event = { ...eventOf(), occurredAt: new Date(millis) };

      const result = await callWrite(store, operation, event, snapshotOf());

      expect(result).toEqual(Result.ok(undefined));
      expect(target[operation].mock.calls[0][0].occurredAt.getTime()).toBe(
        millis,
      );
      expectOnlyCall(target, operation);
    },
  );

  test.each([Number.NaN, -9223372036855, 9223372036855])(
    "preserves occurredAt across an asynchronous target wait when the caller sets %s",
    async (changedMillis) => {
      const target = createTarget();
      const store = createValidatedEventStore(target);
      const occurredAt = new Date(7);
      const event = { ...eventOf(), occurredAt };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const observed = Promise.withResolvers<{
        occurredAt: Date;
        millis: number;
      }>();
      const observeTime = async (delegated: EventEnvelope) => {
        entered.resolve();
        await release.promise;
        observed.resolve({
          occurredAt: delegated.occurredAt,
          millis: delegated.occurredAt.getTime(),
        });
      };
      target.persistEvent.mockImplementation(async (delegated) => {
        await observeTime(delegated);
        return Result.ok(undefined);
      });
      target.persistEventAndSnapshot.mockImplementation(async (delegated) => {
        await observeTime(delegated);
        return Result.ok(undefined);
      });

      const pending = callWrite(store, operation, event, snapshotOf());
      await entered.promise;
      occurredAt.setTime(changedMillis);
      release.resolve();
      const result = await pending;
      const consumed = await observed.promise;

      expect(result).toEqual(Result.ok(undefined));
      expect(consumed.millis).toBe(7);
      expect(consumed.occurredAt).not.toBe(occurredAt);
      expect(occurredAt.getTime()).toBe(changedMillis);
      expectOnlyCall(target, operation);
    },
  );

  test.each([
    new Date(-9223372036855),
    new Date(9223372036855),
    new Date(NaN),
    "1970-01-01T00:00:00Z",
    0,
  ])("rejects occurredAt %p with T-13", async (occurredAt) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await callWrite(
      store,
      operation,
      { ...eventOf(), occurredAt } as EventEnvelope,
      snapshotOf(),
    );

    const error = expectViolation(result, "T-13");
    expect(error).toHaveProperty("seqNr", 1);
    expect(error.message).toContain("seqNr=1");
    expectNoCalls(target);
  });
});

describe.each(operations)("%s aggregate ID validation", (operation) => {
  test("delegates a frozen ID snapshot across an asynchronous target wait", async () => {
    const target = createTarget();
    const store = createValidatedEventStore(target);
    const id = { typeName: "Order", value: "1" };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<{
      aggregateId: AggregateId;
      typeName: string;
      value: string;
      frozen: boolean;
    }>();
    const observeId = async (delegatedId: AggregateId) => {
      entered.resolve();
      await release.promise;
      observed.resolve({
        aggregateId: delegatedId,
        typeName: delegatedId.typeName,
        value: delegatedId.value,
        frozen: Object.isFrozen(delegatedId),
      });
    };
    target.persistEvent.mockImplementation(async (event) => {
      await observeId(event.aggregateId);
      return Result.ok(undefined);
    });
    target.persistEventAndSnapshot.mockImplementation(async (event) => {
      await observeId(event.aggregateId);
      return Result.ok(undefined);
    });
    target.getLatestSnapshotById.mockImplementation(async (aggregateId) => {
      await observeId(aggregateId);
      return Result.ok(undefined);
    });
    target.getEventsByIdSinceSeqNr.mockImplementation(async (aggregateId) => {
      await observeId(aggregateId);
      return Result.ok([]);
    });

    const pending = callWithId(store, operation, id);
    await entered.promise;
    id.typeName = "ChangedOrder";
    id.value = "2";
    release.resolve();
    const result = await pending;
    const consumed = await observed.promise;

    expect(result.type).toBe("ok");
    expect(consumed).toMatchObject({ typeName: "Order", value: "1" });
    expect(consumed.aggregateId).not.toBe(id);
    expect(consumed.frozen).toBe(true);
    expectOnlyCall(target, operation);
  });

  test("reads each caller ID property once", async () => {
    const target = createTarget();
    const store = createValidatedEventStore(target);
    const typeName = jest.fn(() => "Order");
    const value = jest.fn(() => "1");
    const id = {
      get typeName() {
        return typeName();
      },
      get value() {
        return value();
      },
    };

    const result = await callWithId(store, operation, id);

    expect(result.type).toBe("ok");
    expect(typeName).toHaveBeenCalledTimes(1);
    expect(value).toHaveBeenCalledTimes(1);
    expectOnlyCall(target, operation);
  });

  test.each([
    [undefined, "T-2"],
    [null, "T-2"],
    [{ value: "1" }, "T-2"],
    [{ typeName: "Order" }, "T-2"],
    [{ typeName: null, value: "1" }, "T-2"],
    [{ typeName: "Order", value: 1 }, "T-2"],
    [{ typeName: "Order-item", value: "1" }, "T-11"],
    [{ typeName: "a", value: "b".repeat(1023) }, "T-12"],
    [{ typeName: "型", value: `${"値".repeat(340)}a` }, "T-12"],
  ] as const)("rejects %p with %s", async (id, rule) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await callWithId(store, operation, id as AggregateId);

    expectViolation(result, rule);
    expectNoCalls(target);
  });

  test.each([
    { typeName: "", value: "1" },
    { typeName: "Order", value: "" },
    { typeName: "", value: "" },
    { typeName: "Order", value: "item-1" },
    { typeName: "a", value: "b".repeat(1022) },
    { typeName: "型", value: "値".repeat(340) },
  ])("accepts valid ID %p", async (id) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await callWithId(store, operation, id);

    expect(result.type).toBe("ok");
    expectOnlyCall(target, operation);
    const argument = target[operation].mock.calls[0][0];
    expect("aggregateId" in argument ? argument.aggregateId : argument).toEqual(
      id,
    );
  });

  test("does not depend on user stringification", async () => {
    const target = createTarget();
    const store = createValidatedEventStore(target);
    const asString = jest.fn(() => "unrelated");
    const userToString = jest.fn(() => "unrelated");
    const id = { ...aggregateId, asString, toString: userToString };

    const result = await callWithId(store, operation, id);

    expect(result.type).toBe("ok");
    expect(asString).not.toHaveBeenCalled();
    expect(userToString).not.toHaveBeenCalled();
    expectOnlyCall(target, operation);
  });
});

describe("persistEventAndSnapshot snapshot validation", () => {
  describe("caller property snapshot", () => {
    test.each(["seqNr", "manifest", "aggregate"])(
      "delegates the first snapshot %s getter value",
      async (key) => {
        const target = createTarget();
        const store = createValidatedEventStore(target);
        const first = snapshotOf();
        const getters = Object.fromEntries(
          Object.entries(first).map(([name, value]) => [
            name,
            jest
              .fn()
              .mockReturnValueOnce(value)
              .mockReturnValue(name === key ? undefined : value),
          ]),
        );
        const snapshot = Object.defineProperties(
          {},
          Object.fromEntries(
            Object.entries(getters).map(([name, get]) => [name, { get }]),
          ),
        ) as SnapshotEnvelope;

        const result = await store.persistEventAndSnapshot(eventOf(), snapshot);

        expect(result).toEqual(Result.ok(undefined));
        expectOnlyCall(target, "persistEventAndSnapshot");
        const delegated = target.persistEventAndSnapshot.mock.calls[0][1];
        expect(delegated).toEqual(first);
        expect(delegated.aggregate).toBe(first.aggregate);
        for (const getter of Object.values(getters)) {
          expect(getter).toHaveBeenCalledTimes(1);
        }
      },
    );

    test.each(["seqNr", "aggregate"])(
      "rejects a first missing snapshot %s getter value before any target call",
      async (key) => {
        const target = createTarget();
        const store = createValidatedEventStore(target);
        const values = snapshotOf(7);
        const getters = Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            jest
              .fn()
              .mockReturnValueOnce(name === key ? undefined : value)
              .mockReturnValue(value),
          ]),
        );
        const snapshot = Object.defineProperties(
          {},
          Object.fromEntries(
            Object.entries(getters).map(([name, get]) => [name, { get }]),
          ),
        ) as SnapshotEnvelope;

        const result = await store.persistEventAndSnapshot(
          eventOf(7),
          snapshot,
        );

        const error = expectViolation(result, "T-10");
        if (key === "seqNr") {
          expect(error).not.toHaveProperty("seqNr");
          expect(error.message).not.toContain("seqNr=");
        } else {
          expect(error).toHaveProperty("seqNr", 7);
          expect(error.message).toContain("seqNr=7");
        }
        expectNoCalls(target);
        for (const getter of Object.values(getters)) {
          expect(getter).toHaveBeenCalledTimes(1);
        }
      },
    );
  });

  test("preserves T-10 before snapshot number validation", async () => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await store.persistEventAndSnapshot(eventOf(), {
      ...snapshotOf(),
      seqNr: -1,
      aggregate: undefined,
    });

    expectViolation(result, "T-10");
    expectNoCalls(target);
  });

  test("rejects the first mismatched snapshot number even if its getter later matches", async () => {
    const target = createTarget();
    const store = createValidatedEventStore(target);
    const seqNr = jest.fn().mockReturnValueOnce(2).mockReturnValue(1);
    const snapshot = {
      manifest: "snapshot/v1",
      aggregate: null,
      get seqNr() {
        return seqNr();
      },
    };

    const result = await store.persistEventAndSnapshot(eventOf(), snapshot);

    const error = expectViolation(result, "W-9");
    expect(error).toMatchObject({ seqNr: 1, snapshotSeqNr: 2 });
    expect(error.message).toContain("seqNr=1");
    expect(error.message).toContain("snapshotSeqNr=2");
    expect(seqNr).toHaveBeenCalledTimes(1);
    expectNoCalls(target);
  });

  test.each([undefined, null])(
    "rejects an absent snapshot %p",
    async (input) => {
      const target = createTarget();
      const store = createValidatedEventStore(target);

      const result = await store.persistEventAndSnapshot(
        eventOf(),
        input as unknown as SnapshotEnvelope,
      );

      expectViolation(result, "T-10");
      expectNoCalls(target);
    },
  );

  test.each([
    { aggregate: null },
    { ...snapshotOf(), seqNr: undefined },
    { ...snapshotOf(), seqNr: null },
    { seqNr: 1, manifest: "snapshot/v1" },
    { ...snapshotOf(), aggregate: undefined },
  ])("rejects missing required snapshot elements %p", async (input) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await store.persistEventAndSnapshot(
      eventOf(),
      input as SnapshotEnvelope,
    );

    const error = expectViolation(result, "T-10");
    if (input.seqNr == null) {
      expect(error).not.toHaveProperty("seqNr");
      expect(error.message).not.toContain("seqNr=");
    } else {
      expect(error).toHaveProperty("seqNr", 1);
      expect(error.message).toContain("seqNr=1");
    }
    expectNoCalls(target);
  });

  test.each([
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    "1",
    true,
    { toString: null, valueOf: null },
  ])("rejects snapshot seqNr %p with T-9", async (seqNr) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await store.persistEventAndSnapshot(eventOf(), {
      ...snapshotOf(),
      seqNr,
    } as SnapshotEnvelope);

    expectViolation(result, "T-9");
    expectNoCalls(target);
  });

  test.each([
    [1, 0],
    [1, 2],
    [2, 1],
  ])(
    "rejects event %s and snapshot %s with W-9",
    async (seqNr, snapshotSeqNr) => {
      const target = createTarget();
      const store = createValidatedEventStore(target);

      const result = await store.persistEventAndSnapshot(
        eventOf(seqNr),
        snapshotOf(snapshotSeqNr),
      );

      const error = expectViolation(result, "W-9");
      expect(error).toMatchObject({ seqNr, snapshotSeqNr });
      expect(error.message).toContain(`seqNr=${seqNr}`);
      expect(error.message).toContain(`snapshotSeqNr=${snapshotSeqNr}`);
      expectNoCalls(target);
    },
  );
});

describe("getEventsByIdSinceSeqNr", () => {
  test.each([0, 1, Number.MAX_SAFE_INTEGER])(
    "delegates the inclusive start %s and returns envelopes",
    async (seqNr) => {
      const target = createTarget();
      const expected = Result.ok([eventOf(Math.max(1, seqNr))]);
      target.getEventsByIdSinceSeqNr.mockResolvedValue(expected);
      const store = createValidatedEventStore(target);

      const result = await store.getEventsByIdSinceSeqNr(aggregateId, seqNr);

      expect(result).toEqual(expected);
      expect(target.getEventsByIdSinceSeqNr).toHaveBeenCalledWith(
        aggregateId,
        seqNr,
      );
      expectOnlyCall(target, "getEventsByIdSinceSeqNr");
    },
  );

  test("preserves an empty event result", async () => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await store.getEventsByIdSinceSeqNr(aggregateId, 1);

    expect(result).toEqual(Result.ok([]));
    expectOnlyCall(target, "getEventsByIdSinceSeqNr");
  });

  test.each([
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    "0",
    true,
    undefined,
    null,
    { toString: null, valueOf: null },
  ])("rejects start %p with T-9", async (seqNr) => {
    const target = createTarget();
    const store = createValidatedEventStore(target);

    const result = await store.getEventsByIdSinceSeqNr(
      aggregateId,
      seqNr as number,
    );

    const error = expectViolation(result, "T-9");
    if (typeof seqNr === "number") {
      expect(error).toHaveProperty("seqNr", seqNr);
      expect(error.message).toContain(`seqNr=${seqNr}`);
    } else {
      expect(error).not.toHaveProperty("seqNr");
    }
    expectNoCalls(target);
  });
});

describe("getLatestSnapshotById", () => {
  test.each<LatestSnapshot | undefined>([
    undefined,
    { headSeqNr: 3 },
    { headSeqNr: 3, snapshot: snapshotOf(2) },
  ])("preserves the latest snapshot result %p", async (latest) => {
    const target = createTarget();
    const expected = Result.ok(latest);
    target.getLatestSnapshotById.mockResolvedValue(expected);
    const store = createValidatedEventStore(target);

    const result = await store.getLatestSnapshotById(aggregateId);

    expect(result).toEqual(expected);
    expect(target.getLatestSnapshotById).toHaveBeenCalledWith(aggregateId);
    expectOnlyCall(target, "getLatestSnapshotById");
  });
});

describe.each(operations)("%s delegated errors", (operation) => {
  test.each([
    EventStoreError.optimisticLockConflict({
      aggregateId: "Order-1",
      seqNr: 1,
      headSeqNr: 1,
    }),
    EventStoreError.contractViolation({ rule: "W-8", seqNr: 3 }),
    EventStoreError.serialization("serialize", "cannot serialize", new Error()),
    EventStoreError.configuration("retention", "invalid setting", new Error()),
    EventStoreError.storage("storage failed", new Error()),
  ])("preserves classification, fields and cause: $type", async (error) => {
    const target = createTarget();
    const expected = Result.err(error);
    target[operation].mockResolvedValue(expected);
    const store = createValidatedEventStore(target);

    const result = await callWithId(store, operation, aggregateId);

    expect(result).toEqual(expected);
    expectOnlyCall(target, operation);
  });
});

test("supports independent event payload and snapshot state types", async () => {
  const target = createTarget<string, number>();
  const store: EventStore<string, number> = createValidatedEventStore(target);
  const event: EventEnvelope<string> = { ...eventOf(), payload: "created" };
  const snapshot: SnapshotEnvelope<number> = { ...snapshotOf(), aggregate: 42 };

  const result = await store.persistEventAndSnapshot(event, snapshot);

  expect(result).toEqual(Result.ok(undefined));
  expect(target.persistEventAndSnapshot).toHaveBeenCalledWith(event, snapshot);
});
