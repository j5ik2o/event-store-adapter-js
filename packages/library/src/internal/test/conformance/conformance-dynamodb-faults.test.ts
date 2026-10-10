import {
  type DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBPersistEventObservation } from "../dynamodb-persist-event-observation";
import { ConformanceDynamoDBFaults } from "./conformance-dynamodb-faults";
import { ConformanceFaultRegistry } from "./conformance-fault-registry";

const tables = { journal: "journal", snapshot: "snapshot", head: "head" };
const observation = {
  beginRetention: jest.fn(),
  beginReadEvents: jest.fn(),
  beginReadSnapshot: jest.fn(),
  snapshot: () => ({ observations: [] }),
} as unknown as DynamoDBPersistEventObservation;
const subject = (registry = new ConformanceFaultRegistry([])) =>
  new ConformanceDynamoDBFaults(
    registry,
    {} as DynamoDBClient,
    tables,
    "history",
    observation,
    async () => undefined,
  );

test("classifies configuration, commit, real read and retention requests by actual target", () => {
  const faults = subject();
  expect(
    faults.context("TransactWriteItemsCommand", {
      TransactItems: [{ Put: { Item: { aid: { S: "__config__" } } } }],
    }).phase,
  ).toBe("configuration-create");
  expect(
    faults.phase("BatchGetItemCommand", {
      RequestItems: { journal: { Keys: [{ aid: { S: "__config__" } }] } },
    }),
  ).toBe("configuration-read");
  expect(faults.phase("QueryCommand", { TableName: "journal" })).toBe(
    "read-events",
  );
  expect(
    faults.phase("QueryCommand", {
      TableName: "snapshot",
      IndexName: "history",
    }),
  ).toBe("retention-query");
  expect(faults.phase("BatchWriteItemCommand", {})).toBe("retention-delete");
  expect(faults.phase("UpdateItemCommand", { TableName: "snapshot" })).toBe(
    "retention-mark",
  );
  expect(() => faults.phase("GetItemCommand", {})).toThrow("unexpected");
});

test("cancellation reasons follow real transaction action positions, not declaration order", async () => {
  const registry = new ConformanceFaultRegistry([
    {
      operation: 1,
      phase: "commit",
      kind: "sdk-error",
      injection: "replace-request",
      repeat: { mode: "count", count: 1 },
      details: {
        code: "TransactionCanceledException",
        message: "conflict",
        cancellation_reasons: [
          { target: "journal", code: "None" },
          {
            target: "head",
            code: "ConditionalCheckFailed",
            old_head_seq_nr: BigInt(3),
          },
        ],
      },
    },
  ]);
  const faults = subject(registry);
  faults.begin(1);
  const input = {
    TransactItems: [
      { Update: { TableName: "head" } },
      { Put: { TableName: "journal", Item: { seq_nr: { N: "4" } } } },
    ],
  };
  const result = faults.before("TransactWriteItemsCommand", input);
  await expect(result).rejects.toBeInstanceOf(TransactionCanceledException);
  await expect(result).rejects.toMatchObject({
    CancellationReasons: [
      { Code: "ConditionalCheckFailed", Item: { seq_nr: { N: "3" } } },
      { Code: "None" },
    ],
  });
  faults.finish(1);
  expect(faults.evidence()).toMatchObject({
    faults: [{ fired: 1, applied: 1 }],
  });
});
