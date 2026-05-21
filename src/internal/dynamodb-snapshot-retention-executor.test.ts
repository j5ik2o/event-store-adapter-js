import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
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
    const snapshotItems = Array.from({ length: 27 }, (_, index) => {
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
    const snapshotKeyQueries = sentCommands.filter((command) => {
      return command instanceof QueryCommand;
    }) as QueryCommand[];
    expect(snapshotKeyQueries).toHaveLength(1);
    expect(snapshotKeyQueries[0].input.Select).toBeUndefined();
    expect(snapshotKeyQueries[0].input.ScanIndexForward).toBe(true);
    expect(snapshotKeyQueries[0].input.FilterExpression).toBeUndefined();
  });

  test("collects excess snapshot keys across query pages", async () => {
    const sentCommands: unknown[] = [];
    const dynamodbClient = {
      send: jest.fn(async (command: unknown) => {
        sentCommands.push(command);
        if (command instanceof QueryCommand) {
          if (command.input.ExclusiveStartKey === undefined) {
            return {
              Items: [
                {
                  pkey: { S: "oldest-pkey-1" },
                  skey: { S: "oldest-skey-1" },
                },
              ],
              LastEvaluatedKey: {
                pkey: { S: "cursor-pkey" },
                skey: { S: "cursor-skey" },
              },
            };
          }
          return {
            Items: [
              {
                pkey: { S: "oldest-pkey-2" },
                skey: { S: "oldest-skey-2" },
              },
              {
                pkey: { S: "newest-pkey" },
                skey: { S: "newest-skey" },
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

    await executor.purgeExcessSnapshots(new TestAggregateId("1"), 1, undefined);

    const deleteCommand = sentCommands.find((command) => {
      return command instanceof BatchWriteItemCommand;
    }) as BatchWriteItemCommand;
    expect(deleteCommand.input.RequestItems?.snapshot).toEqual([
      {
        DeleteRequest: {
          Key: {
            pkey: { S: "oldest-pkey-1" },
            skey: { S: "oldest-skey-1" },
          },
        },
      },
      {
        DeleteRequest: {
          Key: {
            pkey: { S: "oldest-pkey-2" },
            skey: { S: "oldest-skey-2" },
          },
        },
      },
    ]);
    const snapshotKeyQueries = sentCommands.filter((command) => {
      return (
        command instanceof QueryCommand && command.input.Select !== "COUNT"
      );
    }) as QueryCommand[];
    expect(snapshotKeyQueries).toHaveLength(2);
    expect(snapshotKeyQueries[1].input.ExclusiveStartKey).toEqual({
      pkey: { S: "cursor-pkey" },
      skey: { S: "cursor-skey" },
    });
  });

  test("derives excess snapshots from collected keys without count query", async () => {
    const sentCommands: unknown[] = [];
    const dynamodbClient = {
      send: jest.fn(async (command: unknown) => {
        sentCommands.push(command);
        if (command instanceof QueryCommand) {
          return {
            Items: [
              {
                pkey: { S: "oldest-pkey-1" },
                skey: { S: "oldest-skey-1" },
              },
              {
                pkey: { S: "oldest-pkey-2" },
                skey: { S: "oldest-skey-2" },
              },
              {
                pkey: { S: "newest-pkey" },
                skey: { S: "newest-skey" },
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

    await executor.purgeExcessSnapshots(new TestAggregateId("1"), 1, undefined);

    const snapshotKeyQueries = sentCommands.filter((command) => {
      return command instanceof QueryCommand;
    }) as QueryCommand[];
    expect(snapshotKeyQueries).toHaveLength(1);
    expect(snapshotKeyQueries[0].input.Select).toBeUndefined();
    const deleteCommand = sentCommands.find((command) => {
      return command instanceof BatchWriteItemCommand;
    }) as BatchWriteItemCommand;
    expect(deleteCommand.input.RequestItems?.snapshot).toEqual([
      {
        DeleteRequest: {
          Key: {
            pkey: { S: "oldest-pkey-1" },
            skey: { S: "oldest-skey-1" },
          },
        },
      },
      {
        DeleteRequest: {
          Key: {
            pkey: { S: "oldest-pkey-2" },
            skey: { S: "oldest-skey-2" },
          },
        },
      },
    ]);
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
          return {
            Items: [
              {
                pkey: { S: "snapshot-pkey-1" },
                skey: { S: "snapshot-skey-1" },
              },
              {
                pkey: { S: "snapshot-pkey-2" },
                skey: { S: "snapshot-skey-2" },
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
          return {
            Items: [
              {
                pkey: { S: "snapshot-pkey-1" },
                skey: { S: "snapshot-skey-1" },
              },
              {
                pkey: { S: "snapshot-pkey-2" },
                skey: { S: "snapshot-skey-2" },
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
      ConditionExpression: "attribute_exists(pkey) AND attribute_exists(skey)",
    });
    const snapshotKeyQuery = sentCommands.filter((command) => {
      return command instanceof QueryCommand;
    })[0] as QueryCommand;
    expect(snapshotKeyQuery.input.FilterExpression).toBe("#ttl = :ttl");
  });

  test("ignores ttl update when snapshot was already deleted", async () => {
    const dynamodbClient = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof QueryCommand) {
          return {
            Items: [
              {
                pkey: { S: "snapshot-pkey-1" },
                skey: { S: "snapshot-skey-1" },
              },
              {
                pkey: { S: "snapshot-pkey-2" },
                skey: { S: "snapshot-skey-2" },
              },
            ],
          };
        }
        if (command instanceof UpdateItemCommand) {
          throw new ConditionalCheckFailedException({
            $metadata: {},
            message: "snapshot was already deleted",
          });
        }
        return {};
      }),
    } as unknown as DynamoDBClient;
    const executor = new DynamoDBSnapshotRetentionExecutor(
      dynamodbClient,
      "snapshot",
      "snapshot-aid-index",
    );

    await expect(
      executor.purgeExcessSnapshots(
        new TestAggregateId("1"),
        1,
        moment.duration(1, "hour"),
      ),
    ).resolves.toBeUndefined();
  });
});
