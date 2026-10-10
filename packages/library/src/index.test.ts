import {
  AggregateId,
  EventEnvelope,
  EventStore,
  MemoryStorage,
  PayloadSerializer,
  SnapshotEnvelope,
} from ".";

function unwrap<T>(
  result: { type: "ok"; value: T } | { type: "err"; error: unknown },
): T {
  if (result.type === "err") throw result.error;
  return result.value;
}

test("root API consumes four operations, explicit sharing and default isolation", async () => {
  const storage = unwrap(MemoryStorage.create());
  const first = unwrap(EventStore.createMemory({ storage }));
  const shared = unwrap(EventStore.createMemory({ storage }));
  const independent = unwrap(EventStore.createMemory());
  const id = unwrap(AggregateId.of("Order", "1"));
  const event = unwrap(
    EventEnvelope.create({
      aggregateId: id,
      seqNr: 1,
      occurredAt: new Date(123),
      payload: { item: "book" },
    }),
  );
  const snapshot = unwrap(
    SnapshotEnvelope.create({ seqNr: 1, aggregate: { total: 1 } }),
  );
  expect(await first.persistEventAndSnapshot(event, snapshot)).toEqual({
    type: "ok",
    value: undefined,
  });
  const next = unwrap(
    EventEnvelope.create({ ...event, seqNr: 2, payload: { item: "pen" } }),
  );
  expect(await shared.persistEvent(next)).toEqual({
    type: "ok",
    value: undefined,
  });
  expect(await shared.getEventsByIdSinceSeqNr(id, 1)).toEqual({
    type: "ok",
    value: [event, next],
  });
  expect(await shared.getLatestSnapshotById(id)).toEqual({
    type: "ok",
    value: { headSeqNr: 2, snapshot },
  });
  expect(await independent.getLatestSnapshotById(id)).toEqual({
    type: "ok",
    value: undefined,
  });
});

test("root API exposes original serialization cause in Result", async () => {
  const cause = new Error("domain encoding failed");
  const json = PayloadSerializer.json();
  const store = unwrap(
    EventStore.createMemory({
      eventSerializer: {
        ...json,
        serialize: () => {
          throw cause;
        },
      },
    }),
  );
  const event = unwrap(
    EventEnvelope.create({
      aggregateId: { typeName: "Order", value: "2" },
      seqNr: 1,
      occurredAt: new Date(0),
      payload: {},
    }),
  );
  const result = await store.persistEvent(event);
  expect(result.type).toBe("err");
  if (result.type === "err") {
    expect(result.error.type).toBe("serialization-error");
    expect(result.error.cause).toBe(cause);
  }
});
