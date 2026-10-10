import { types } from "node:util";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { AggregateId } from "./aggregate-id";
import { EventStore } from "./event-store";
import type { EventStoreError } from "./event-store-error";
import * as memoryStorageRecords from "./internal/memory-storage-records";
import { DynamoDBLocal } from "./internal/test/dynamodb-local";
import { DynamoDBPersistEventObservation } from "./internal/test/dynamodb-persist-event-observation";
import { MemoryStorage } from "./memory-storage";
import { PayloadSerializer } from "./payload-serializer";
import type { Result } from "./result";

const operations = [
  "persistEvent",
  "persistEventAndSnapshot",
  "getLatestSnapshotById",
  "getEventsByIdSinceSeqNr",
] as const;
const malformedIds = [
  { typeName: "\uD800", value: "1" },
  { typeName: "\uD801", value: "1" },
  { typeName: "\uDC00", value: "1" },
  { typeName: "Order", value: "\uD800" },
  { typeName: "Order", value: "\uD801" },
  { typeName: "Order", value: "\uDC00" },
];

function callWithId(
  store: EventStore,
  operation: keyof EventStore,
  aggregateId: AggregateId,
  seqNr = 1,
): Promise<Result<unknown, EventStoreError>> {
  const event = {
    aggregateId,
    seqNr,
    occurredAt: new Date(0),
    manifest: "event/v1",
    payload: { count: seqNr },
  };
  switch (operation) {
    case "persistEvent":
      return store.persistEvent(event);
    case "persistEventAndSnapshot":
      return store.persistEventAndSnapshot(event, {
        seqNr,
        manifest: "snapshot/v1",
        aggregate: { total: seqNr },
      });
    case "getLatestSnapshotById":
      return store.getLatestSnapshotById(aggregateId);
    case "getEventsByIdSinceSeqNr":
      return store.getEventsByIdSinceSeqNr(aggregateId, seqNr);
  }
}

function observedSerializer() {
  const json = PayloadSerializer.json();
  return {
    serialize: jest.fn(json.serialize),
    deserialize: jest.fn(json.deserialize),
  };
}

function unreadableSerializedBytes(kind: "detached" | "proxy") {
  const bytes = Uint8Array.of(1);
  if (kind === "detached") {
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return { bytes, cause: undefined };
  }
  const cause = new TypeError("bytes iteration failed");
  return {
    bytes: new Proxy(bytes, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) throw cause;
        return Reflect.get(target, key, receiver);
      },
    }),
    cause,
  };
}

describe.each(["persistEvent", "persistEventAndSnapshot"] as const)(
  "public createMemory %s byte copies",
  (operation) => {
    test.each(["detached", "proxy"] as const)(
      "classifies %s copy failure before commit",
      async (kind) => {
        const { bytes, cause } = unreadableSerializedBytes(kind);
        const serialize = jest.fn(() => bytes);
        const snapshotSerializer = observedSerializer();
        const opened = EventStore.createMemory({
          eventSerializer: { ...PayloadSerializer.json(), serialize },
          snapshotSerializer,
        });
        if (opened.type !== "ok") throw new Error("open failed");
        const commit = jest.spyOn(
          memoryStorageRecords,
          "commitMemoryStorageRecords",
        );
        const aggregateId = { typeName: "Order", value: "copy" };
        try {
          const result = await callWithId(opened.value, operation, aggregateId);

          expect(result).toMatchObject({
            type: "err",
            error: { type: "serialization-error", operation: "serialize" },
          });
          if (result.type !== "err") throw new Error("serialization succeeded");
          expect(types.isNativeError(result.error.cause)).toBe(true);
          expect(result.error.cause).toMatchObject({ name: "TypeError" });
          if (cause !== undefined) expect(result.error.cause).toBe(cause);
          expect(serialize).toHaveBeenCalledTimes(1);
          expect(snapshotSerializer.serialize).not.toHaveBeenCalled();
          expect(commit).not.toHaveBeenCalled();
          expect(await opened.value.getLatestSnapshotById(aggregateId)).toEqual(
            { type: "ok", value: undefined },
          );
          expect(
            await opened.value.getEventsByIdSinceSeqNr(aggregateId, 1),
          ).toEqual({ type: "ok", value: [] });
        } finally {
          commit.mockRestore();
        }
      },
    );
  },
);

test("public createMemory isolates serializer bytes while pending and after commit", async () => {
  const bytes = Buffer.from('{"count":1}');
  const opened = EventStore.createMemory({
    eventSerializer: { ...PayloadSerializer.json(), serialize: () => bytes },
  });
  if (opened.type !== "ok") throw new Error("open failed");
  const aggregateId = { typeName: "Order", value: "copy" };
  const pending = callWithId(opened.value, "persistEvent", aggregateId);
  bytes.fill(0);
  expect(await pending).toEqual({ type: "ok", value: undefined });
  expect(
    await opened.value.getEventsByIdSinceSeqNr(aggregateId, 1),
  ).toMatchObject({ type: "ok", value: [{ payload: { count: 1 } }] });
  bytes.fill(99);
  expect(
    await opened.value.getEventsByIdSinceSeqNr(aggregateId, 1),
  ).toMatchObject({ type: "ok", value: [{ payload: { count: 1 } }] });
});

describe("public createMemory Unicode validation", () => {
  describe.each(operations)("%s", (operation) => {
    test.each(malformedIds)(
      "rejects %p before serializer or storage calls",
      async (aggregateId) => {
        const storage = MemoryStorage.create();
        if (storage.type !== "ok") throw new Error("storage creation failed");
        const eventSerializer = observedSerializer();
        const snapshotSerializer = observedSerializer();
        const opened = EventStore.createMemory({
          storage: storage.value,
          eventSerializer,
          snapshotSerializer,
        });
        if (opened.type !== "ok") throw new Error("open failed");
        const commit = jest.spyOn(
          memoryStorageRecords,
          "commitMemoryStorageRecords",
        );
        const readSnapshot = jest.spyOn(
          memoryStorageRecords,
          "readMemoryStorageLatestSnapshot",
        );
        const readEvents = jest.spyOn(
          memoryStorageRecords,
          "readMemoryStorageEvents",
        );
        try {
          const result = await callWithId(opened.value, operation, aggregateId);

          expect(result).toMatchObject({
            type: "err",
            error: { type: "contract-violation", rule: "T-12" },
          });
          expect(eventSerializer.serialize).not.toHaveBeenCalled();
          expect(eventSerializer.deserialize).not.toHaveBeenCalled();
          expect(snapshotSerializer.serialize).not.toHaveBeenCalled();
          expect(snapshotSerializer.deserialize).not.toHaveBeenCalled();
          expect(commit).not.toHaveBeenCalled();
          expect(readSnapshot).not.toHaveBeenCalled();
          expect(readEvents).not.toHaveBeenCalled();
        } finally {
          commit.mockRestore();
          readSnapshot.mockRestore();
          readEvents.mockRestore();
        }
      },
    );
  });

  describe.each(["persistEvent", "persistEventAndSnapshot"] as const)(
    "%s",
    (operation) => {
      test.each([
        [-1, "T-9"],
        [0, "W-6"],
      ] as const)(
        "preserves seqNr=%s priority over malformed UTF-16: %s",
        async (seqNr, rule) => {
          const serializer = observedSerializer();
          const opened = EventStore.createMemory({
            eventSerializer: serializer,
            snapshotSerializer: serializer,
          });
          if (opened.type !== "ok") throw new Error("open failed");

          expect(
            await callWithId(opened.value, operation, malformedIds[0], seqNr),
          ).toMatchObject({
            type: "err",
            error: { type: "contract-violation", rule },
          });
          expect(serializer.serialize).not.toHaveBeenCalled();
          expect(serializer.deserialize).not.toHaveBeenCalled();
        },
      );
    },
  );

  test("preserves a surrogate pair in all four operations", async () => {
    const opened = EventStore.createMemory();
    if (opened.type !== "ok") throw new Error("open failed");
    const aggregateId = { typeName: "\uD83D\uDE80", value: "\uD83D\uDE03" };

    expect(
      await callWithId(opened.value, "persistEvent", aggregateId),
    ).toMatchObject({ type: "ok" });
    expect(
      await callWithId(opened.value, "persistEventAndSnapshot", aggregateId, 2),
    ).toMatchObject({ type: "ok" });
    expect(
      await callWithId(opened.value, "getLatestSnapshotById", aggregateId),
    ).toMatchObject({
      type: "ok",
      value: { headSeqNr: 2, snapshot: { seqNr: 2, aggregate: { total: 2 } } },
    });
    expect(
      await callWithId(opened.value, "getEventsByIdSinceSeqNr", aggregateId),
    ).toMatchObject({
      type: "ok",
      value: [
        { aggregateId, seqNr: 1 },
        { aggregateId, seqNr: 2 },
      ],
    });
  });
});

test("returns input validation failure without SDK IO", async () => {
  const client = new DynamoDBClient({ region: "us-west-1" });
  const send = jest.spyOn(client, "send");
  try {
    expect(
      await EventStore.createDynamoDB({
        client,
        tables: { journal: "j", snapshot: "j", head: "h" },
        snapshotAidIndexName: "history",
      }),
    ).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "tables" },
    });
    expect(send).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
    client.destroy();
  }
});

describe("public createDynamoDB with DynamoDB Local 3.3.1", () => {
  let local: DynamoDBLocal;
  beforeAll(async () => {
    local = await DynamoDBLocal.start();
  }, 120_000);
  afterAll(async () => {
    if (local !== undefined) await local.stop();
  }, 120_000);

  describe.each(["persistEvent", "persistEventAndSnapshot"] as const)(
    "%s byte copies",
    (operation) => {
      test.each(["detached", "proxy"] as const)(
        "classifies %s copy failure before operation SDK calls",
        async (kind) => {
          const layout = await local.createTables();
          const client = local.createClient();
          const { bytes, cause } = unreadableSerializedBytes(kind);
          const serialize = jest.fn(() => bytes);
          const snapshotSerializer = observedSerializer();
          const opened = await EventStore.createDynamoDB({
            ...layout,
            client,
            eventSerializer: { ...PayloadSerializer.json(), serialize },
            snapshotSerializer,
          });
          if (opened.type !== "ok") throw new Error("open failed");
          const send = jest.spyOn(client, "send");
          try {
            const result = await callWithId(opened.value, operation, {
              typeName: "Order",
              value: "copy",
            });

            expect(result).toMatchObject({
              type: "err",
              error: { type: "serialization-error", operation: "serialize" },
            });
            if (result.type !== "err")
              throw new Error("serialization succeeded");
            expect(types.isNativeError(result.error.cause)).toBe(true);
            expect(result.error.cause).toMatchObject({ name: "TypeError" });
            if (cause !== undefined) expect(result.error.cause).toBe(cause);
            expect(serialize).toHaveBeenCalledTimes(1);
            expect(snapshotSerializer.serialize).not.toHaveBeenCalled();
            expect(send).not.toHaveBeenCalled();
          } finally {
            send.mockRestore();
          }
        },
        30_000,
      );
    },
  );

  describe.each(operations)("%s Unicode validation", (operation) => {
    test.each(malformedIds)(
      "rejects %p before serializer or operation SDK calls",
      async (aggregateId) => {
        const layout = await local.createTables();
        const client = local.createClient();
        const eventSerializer = observedSerializer();
        const snapshotSerializer = observedSerializer();
        const opened = await EventStore.createDynamoDB({
          ...layout,
          client,
          eventSerializer,
          snapshotSerializer,
        });
        if (opened.type !== "ok") throw new Error("open failed");
        const send = jest.spyOn(client, "send");
        try {
          const result = await callWithId(opened.value, operation, aggregateId);

          expect(result).toMatchObject({
            type: "err",
            error: { type: "contract-violation", rule: "T-12" },
          });
          expect(eventSerializer.serialize).not.toHaveBeenCalled();
          expect(eventSerializer.deserialize).not.toHaveBeenCalled();
          expect(snapshotSerializer.serialize).not.toHaveBeenCalled();
          expect(snapshotSerializer.deserialize).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
        } finally {
          send.mockRestore();
        }
      },
      30_000,
    );
  });

  describe.each(["persistEvent", "persistEventAndSnapshot"] as const)(
    "%s",
    (operation) => {
      test.each([
        [-1, "T-9"],
        [0, "W-6"],
      ] as const)(
        "preserves seqNr=%s priority over malformed UTF-16: %s",
        async (seqNr, rule) => {
          const layout = await local.createTables();
          const client = local.createClient();
          const serializer = observedSerializer();
          const opened = await EventStore.createDynamoDB({
            ...layout,
            client,
            eventSerializer: serializer,
            snapshotSerializer: serializer,
          });
          if (opened.type !== "ok") throw new Error("open failed");
          const send = jest.spyOn(client, "send");
          try {
            expect(
              await callWithId(opened.value, operation, malformedIds[0], seqNr),
            ).toMatchObject({
              type: "err",
              error: { type: "contract-violation", rule },
            });
            expect(serializer.serialize).not.toHaveBeenCalled();
            expect(serializer.deserialize).not.toHaveBeenCalled();
            expect(send).not.toHaveBeenCalled();
          } finally {
            send.mockRestore();
          }
        },
        30_000,
      );
    },
  );

  test("preserves a surrogate pair in all four operations", async () => {
    const layout = await local.createTables();
    const opened = await EventStore.createDynamoDB({
      ...layout,
      client: local.createClient(),
    });
    if (opened.type !== "ok") throw new Error("open failed");
    const aggregateId = { typeName: "\uD83D\uDE80", value: "\uD83D\uDE03" };

    expect(
      await callWithId(opened.value, "persistEvent", aggregateId),
    ).toMatchObject({ type: "ok" });
    expect(
      await callWithId(opened.value, "persistEventAndSnapshot", aggregateId, 2),
    ).toMatchObject({ type: "ok" });
    expect(
      await callWithId(opened.value, "getLatestSnapshotById", aggregateId),
    ).toMatchObject({
      type: "ok",
      value: { headSeqNr: 2, snapshot: { seqNr: 2, aggregate: { total: 2 } } },
    });
    expect(
      await callWithId(opened.value, "getEventsByIdSinceSeqNr", aggregateId),
    ).toMatchObject({
      type: "ok",
      value: [
        { aggregateId, seqNr: 1 },
        { aggregateId, seqNr: 2 },
      ],
    });
  }, 30_000);

  test("connects all four operations with no history when retention is absent", async () => {
    const layout = await local.createTables();
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client);
    const opened = await EventStore.createDynamoDB({ ...layout, client });
    if (opened.type !== "ok") throw new Error("open failed");
    const store = opened.value;
    const aggregateId = { typeName: "Order", value: "public" };
    expect(await store.getLatestSnapshotById(aggregateId)).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(
      await store.persistEvent({
        aggregateId,
        seqNr: 1,
        occurredAt: new Date(-1),
        manifest: "event/v1",
        payload: { count: 1 },
      }),
    ).toEqual({ type: "ok", value: undefined });
    expect(
      await store.persistEventAndSnapshot(
        {
          aggregateId,
          seqNr: 2,
          occurredAt: new Date(1234),
          manifest: "event/v2",
          payload: { count: 2 },
        },
        { seqNr: 2, manifest: "snapshot/v2", aggregate: { total: 2 } },
      ),
    ).toEqual({ type: "ok", value: undefined });
    expect(await store.getEventsByIdSinceSeqNr(aggregateId, 1)).toMatchObject({
      type: "ok",
      value: [
        { seqNr: 1, occurredAt: new Date(-1), payload: { count: 1 } },
        { seqNr: 2, occurredAt: new Date(1234), payload: { count: 2 } },
      ],
    });
    expect(await store.getLatestSnapshotById(aggregateId)).toEqual({
      type: "ok",
      value: {
        snapshot: {
          seqNr: 2,
          manifest: "snapshot/v2",
          aggregate: { total: 2 },
        },
        headSeqNr: 2,
      },
    });
    const physical = await local.observer.send(
      new QueryCommand({
        TableName: layout.tables.snapshot,
        KeyConditionExpression: "aid = :aid",
        ExpressionAttributeValues: { ":aid": { S: "Order-public" } },
        ConsistentRead: true,
      }),
    );
    expect(physical.Items).toHaveLength(1);
    expect(physical.Items?.[0]).toMatchObject({
      skey: { N: "0" },
      seq_nr: { N: "2" },
    });
    expect(physical.Items?.[0].active_history_seq_nr).toBeUndefined();
    expect(physical.Items?.[0].ttl).toBeUndefined();
    expect(
      observation
        .snapshot()
        .observations.filter(
          ({ commandName, input }) =>
            commandName === "BatchWriteItemCommand" ||
            commandName === "UpdateItemCommand" ||
            (commandName === "QueryCommand" &&
              (input as { IndexName?: string }).IndexName !== undefined),
        ),
    ).toEqual([]);
    observation.assertApplied();
  }, 30_000);

  test("shares a layout across clients, isolates independent layouts and restores custom domain serializers", async () => {
    class Quantity {
      constructor(readonly value: number) {}
      increment(): number {
        return this.value + 1;
      }
    }
    const serializer = {
      serialize: (value: Quantity) => Buffer.from(`quantity:${value.value}`),
      deserialize: (bytes: Uint8Array) =>
        new Quantity(Number(Buffer.from(bytes).toString().split(":")[1])),
    };
    const layout = await local.createTables();
    const independent = await local.createTables();
    const first = await EventStore.createDynamoDB({
      ...layout,
      client: local.createClient(),
      eventSerializer: serializer,
      snapshotSerializer: serializer,
      retention: { count: 1 },
    });
    const shared = await EventStore.createDynamoDB({
      ...layout,
      client: local.createClient(),
      eventSerializer: serializer,
      snapshotSerializer: serializer,
      retention: { count: 1 },
    });
    const isolated = await EventStore.createDynamoDB({
      ...independent,
      client: local.createClient(),
      eventSerializer: serializer,
      snapshotSerializer: serializer,
      retention: { count: 1 },
    });
    if (first.type !== "ok" || shared.type !== "ok" || isolated.type !== "ok")
      throw new Error("open failed");
    const aggregateId = { typeName: "Order", value: "domain" };
    expect(
      await first.value.persistEventAndSnapshot(
        {
          aggregateId,
          seqNr: 1,
          occurredAt: new Date(0),
          manifest: "domain-event",
          payload: new Quantity(2),
        },
        { seqNr: 1, manifest: "domain-snapshot", aggregate: new Quantity(3) },
      ),
    ).toMatchObject({ type: "ok" });
    const events = await shared.value.getEventsByIdSinceSeqNr(aggregateId, 1);
    const latest = await shared.value.getLatestSnapshotById(aggregateId);
    if (
      events.type !== "ok" ||
      latest.type !== "ok" ||
      latest.value === undefined
    )
      throw new Error("read failed");
    expect(events.value[0].payload).toBeInstanceOf(Quantity);
    expect(events.value[0].payload.increment()).toBe(3);
    expect(latest.value.snapshot?.aggregate).toBeInstanceOf(Quantity);
    expect(latest.value.snapshot?.aggregate.increment()).toBe(4);
    expect(
      await isolated.value.getEventsByIdSinceSeqNr(aggregateId, 1),
    ).toEqual({ type: "ok", value: [] });
    expect(await isolated.value.getLatestSnapshotById(aggregateId)).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(
      await EventStore.createDynamoDB({
        ...layout,
        tables: { ...layout.tables, snapshot: independent.tables.snapshot },
        client: local.createClient(),
        retention: { count: 1 },
      }),
    ).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "store_id" },
    });
  }, 30_000);
});
