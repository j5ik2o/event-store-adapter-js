import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import * as factory from "../../dynamodb-event-store";
import type { DynamoDBLocal } from "../dynamodb-local";
import { ConformanceDynamoDBBinding } from "./conformance-dynamodb-binding";

test("generation error keeps request evidence, fault verification and disposal, and restores the factory", async () => {
  const original = factory.initializeDynamoDBEventStoreInternal;
  const clients: DynamoDBClient[] = [];
  const remove = jest.fn(async () => undefined);
  const local = {
    createTables: async () => ({
      tables: {
        journal: "unit-journal",
        snapshot: "unit-snapshot",
        head: "unit-head",
      },
      snapshotAidIndexName: "history",
    }),
    createClient: () => {
      const client = new DynamoDBClient({
        region: "us-west-1",
        endpoint: "http://localhost:1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        maxAttempts: 1,
      });
      clients.push(client);
      return client;
    },
    deleteTables: remove,
  } as unknown as DynamoDBLocal;
  const created = await new ConformanceDynamoDBBinding(local).createStore({
    config: { retentionCount: null, retentionMode: "delete" },
    seedItems: [],
    faults: [
      {
        operation: 0,
        phase: "configuration-read",
        kind: "storage-error",
        injection: "replace-request",
        repeat: { mode: "count", count: 1 },
        details: { message: "offline" },
      },
    ],
  });
  expect(clients).toHaveLength(2);
  expect(clients[0]).not.toBe(clients[1]);
  expect(factory.initializeDynamoDBEventStoreInternal).toBe(original);
  expect(created.outcome).toMatchObject({
    kind: "error",
    category: "storage",
    cause: new Error("offline"),
  });
  created.hooks.finishOperation?.(0);
  expect(created.hooks.evidence?.()).toMatchObject({
    faults: {
      faults: [{ fired: 1, applied: 1 }],
      requests: {
        observations: [{ operation: 0, phase: "configuration-read" }],
      },
    },
  });
  await created.dispose();
  expect(remove).toHaveBeenCalledTimes(1);
});
