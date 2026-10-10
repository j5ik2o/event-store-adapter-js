import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBPersistEventObservation } from "../dynamodb-persist-event-observation";
import { ConformanceDynamoDBObservation } from "./conformance-dynamodb-observation";

const item = {
  aid: { S: "Order-1" },
  seq_nr: { N: "1" },
  payload: { B: Buffer.from('{"ok":true}') },
};
const input = {
  TableName: "journal",
  ConsistentRead: true,
  ScanIndexForward: true,
};
const page = {
  operation: 1,
  phase: "read-events",
  commandName: "QueryCommand",
  input,
  wireBody: JSON.stringify(input),
  upstream: { Items: [item] },
  returned: { Items: [item] },
};

test("compares cloned SDK values, unchanged small pages and independently read physical items", async () => {
  const send = jest.fn(async () => ({ Item: item }));
  const observation = {
    snapshot: () => ({ observations: structuredClone([page]) }),
  } as unknown as DynamoDBPersistEventObservation;
  const inspection = new ConformanceDynamoDBObservation(
    { send } as unknown as DynamoDBClient,
    { journal: "journal", snapshot: "snapshot", head: "head" },
    "history",
    observation,
    () => 1,
  );
  await expect(
    inspection.check(
      {
        requests: [
          {
            api: "Query",
            phase: "read-events",
            constraints: {
              table: "journal",
              consistent_read: true,
              scan_index_forward: true,
            },
          },
        ],
      },
      {},
    ),
  ).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
  expect(inspection.evidence().physical).toHaveLength(2);
});

test("rejects an unrelated continuation key and a response changed below the byte boundary", async () => {
  const observer = {} as DynamoDBClient;
  const observation = {} as DynamoDBPersistEventObservation;
  const inspection = new ConformanceDynamoDBObservation(
    observer,
    { journal: "journal", snapshot: "snapshot", head: "head" },
    "history",
    observation,
    () => 1,
  );
  await expect(
    inspection.checkReadEventPages([
      {
        ...page,
        input: { ...input, ExclusiveStartKey: { aid: { S: "wrong" } } },
      },
    ]),
  ).rejects.toThrow("next Query");
  await expect(
    inspection.checkReadEventPages([{ ...page, returned: { Items: [] } }]),
  ).rejects.toThrow("normal raw page");
});
