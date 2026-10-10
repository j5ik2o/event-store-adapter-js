import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { EventStore } from "./event-store";
import { DynamoDBLocal } from "./internal/test/dynamodb-local";
import { DynamoDBPersistEventObservation } from "./internal/test/dynamodb-persist-event-observation";

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
