import {
  BatchWriteItemCommand,
  type DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import moment from "moment/moment";
import type { AggregateId } from "../types";
import { DynamoDBSnapshotRetentionExecutor } from "./dynamodb-snapshot-retention-executor";

class TestAggregateId implements AggregateId {
  readonly typeName = "test";

  constructor(readonly value: string) {}

  asString(): string {
    return `${this.typeName}-${this.value}`;
  }
}

describe("DynamoDBSnapshotRetentionExecutor", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("deletes excess snapshots when delete ttl is not configured", async () => {
    const snapshotItems = Array.from({ length: 26 }, (_, index) => {
      return {
        pkey: { S: `snapshot-pkey-${index + 1}` },
        skey: { S: `snapshot-skey-${index + 1}` },
      };
    });
    const sentCommands: unknown[] = [];
    const dynamodbClient = {
      send: jest.fn(async (command: unknown) => {
        sentCommands.push(command);
        if (command instanceof QueryCommand) {
          const queryCommandCount = sentCommands.filter((sentCommand) => {
            return sentCommand instanceof QueryCommand;
          }).length;
          if (queryCommandCount === 1) {
            return { Count: 28 };
          }
          return {
            Items: snapshotItems,
          };
        }
        return {};
      }),
    } as unknown as DynamoDBClient;
    const executor = new DynamoDBSnapshotRetentionExecutor(
      dynamodbClient,
      "snapshot",
      "snapshot-aid-index",
    );

    await executor.purgeExcessSnapshots(new TestAggregateId("1"), 1, undefined);

    const deleteCommands = sentCommands.filter((command) => {
      return command instanceof BatchWriteItemCommand;
    });
    expect(deleteCommands).toHaveLength(2);
    expect(
      (deleteCommands[0] as BatchWriteItemCommand).input.RequestItems?.snapshot,
    ).toHaveLength(25);
    expect(
      (deleteCommands[1] as BatchWriteItemCommand).input.RequestItems?.snapshot,
    ).toEqual([
      {
        DeleteRequest: {
          Key: {
            pkey: { S: "snapshot-pkey-26" },
            skey: { S: "snapshot-skey-26" },
          },
        },
      },
    ]);
    const snapshotKeyQuery = sentCommands.filter((command) => {
      return command instanceof QueryCommand;
    })[1] as QueryCommand;
    expect(snapshotKeyQuery.input.FilterExpression).toBeUndefined();
  });

  test("retries unprocessed snapshot deletes", async () => {
    const sentCommands: unknown[] = [];
    const unprocessedRequest = {
      DeleteRequest: {
        Key: {
          pkey: { S: "snapshot-pkey-1" },
          skey: { S: "snapshot-skey-1" },
        },
      },
    };
    const dynamodbClient = {
      send: jest.fn(async (command: unknown) => {
        sentCommands.push(command);
        if (command instanceof QueryCommand) {
          const queryCommandCount = sentCommands.filter((sentCommand) => {
            return sentCommand instanceof QueryCommand;
          }).length;
          if (queryCommandCount === 1) {
            return { Count: 3 };
          }
          return {
            Items: [
              {
                pkey: { S: "snapshot-pkey-1" },
                skey: { S: "snapshot-skey-1" },
              },
            ],
          };
        }
        const batchWriteCommandCount = sentCommands.filter((sentCommand) => {
          return sentCommand instanceof BatchWriteItemCommand;
        }).length;
        if (batchWriteCommandCount === 1) {
          return {
            UnprocessedItems: {
              snapshot: [unprocessedRequest],
            },
          };
        }
        return {};
      }),
    } as unknown as DynamoDBClient;
    const executor = new DynamoDBSnapshotRetentionExecutor(
      dynamodbClient,
      "snapshot",
      "snapshot-aid-index",
    );

    await executor.purgeExcessSnapshots(new TestAggregateId("1"), 1, undefined);

    const deleteCommands = sentCommands.filter((command) => {
      return command instanceof BatchWriteItemCommand;
    });
    expect(deleteCommands).toHaveLength(2);
    expect(
      (deleteCommands[1] as BatchWriteItemCommand).input.RequestItems?.snapshot,
    ).toEqual([unprocessedRequest]);
  });

  test("updates excess snapshots with epoch seconds when delete ttl is configured", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-05-21T00:00:00.000Z"));
    const sentCommands: unknown[] = [];
    const dynamodbClient = {
      send: jest.fn(async (command: unknown) => {
        sentCommands.push(command);
        if (command instanceof QueryCommand) {
          const queryCommandCount = sentCommands.filter((sentCommand) => {
            return sentCommand instanceof QueryCommand;
          }).length;
          if (queryCommandCount === 1) {
            return { Count: 3 };
          }
          return {
            Items: [
              {
                pkey: { S: "snapshot-pkey-1" },
                skey: { S: "snapshot-skey-1" },
              },
            ],
          };
        }
        return {};
      }),
    } as unknown as DynamoDBClient;
    const executor = new DynamoDBSnapshotRetentionExecutor(
      dynamodbClient,
      "snapshot",
      "snapshot-aid-index",
    );

    await executor.purgeExcessSnapshots(
      new TestAggregateId("1"),
      1,
      moment.duration(1, "hour"),
    );

    const updateCommand = sentCommands.find((command) => {
      return command instanceof UpdateItemCommand;
    });
    expect(updateCommand).toBeInstanceOf(UpdateItemCommand);
    expect((updateCommand as UpdateItemCommand).input).toMatchObject({
      TableName: "snapshot",
      Key: {
        pkey: { S: "snapshot-pkey-1" },
        skey: { S: "snapshot-skey-1" },
      },
      ExpressionAttributeValues: {
        ":ttl": { N: "1779325200" },
      },
    });
    const snapshotKeyQuery = sentCommands.filter((command) => {
      return command instanceof QueryCommand;
    })[1] as QueryCommand;
    expect(snapshotKeyQuery.input.FilterExpression).toBe("#ttl = :ttl");
  });
});
