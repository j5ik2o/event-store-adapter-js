import {
  CreateTableCommand,
  CreateTableCommandInput,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { StartedTestContainer } from "testcontainers";

function createDynamoDBClient(startedContainer: StartedTestContainer) {
  const port = startedContainer.getMappedPort(4566);

  const dynamodbClient: DynamoDBClient = new DynamoDBClient({
    region: "us-west-1",
    endpoint: `http://localhost:${port}`,
    credentials: {
      accessKeyId: "x",
      secretAccessKey: "x",
    },
  });
  return dynamodbClient;
}

async function createJournalTable(
  dynamodbClient: DynamoDBClient,
  tableName: string,
  indexName: string,
) {
  const request: CreateTableCommandInput = {
    TableName: tableName,
    AttributeDefinitions: [
      {
        AttributeName: "pkey",
        AttributeType: "S",
      },
      {
        AttributeName: "skey",
        AttributeType: "S",
      },
      {
        AttributeName: "aid",
        AttributeType: "S",
      },
      {
        AttributeName: "seq_nr",
        AttributeType: "N",
      },
    ],
    KeySchema: [
      {
        AttributeName: "pkey",
        KeyType: "HASH",
      },
      {
        AttributeName: "skey",
        KeyType: "RANGE",
      },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: indexName,
        KeySchema: [
          {
            AttributeName: "aid",
            KeyType: "HASH",
          },
          {
            AttributeName: "seq_nr",
            KeyType: "RANGE",
          },
        ],
        Projection: {
          ProjectionType: "ALL",
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 10,
          WriteCapacityUnits: 5,
        },
      },
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 10,
      WriteCapacityUnits: 5,
    },
  };

  await dynamodbClient.send(new CreateTableCommand(request));
}

async function createSnapshotTable(
  dynamodbClient: DynamoDBClient,
  tableName: string,
  indexName: string,
) {
  const request: CreateTableCommandInput = {
    TableName: tableName,
    AttributeDefinitions: [
      {
        AttributeName: "pkey",
        AttributeType: "S",
      },
      {
        AttributeName: "skey",
        AttributeType: "S",
      },
      {
        AttributeName: "aid",
        AttributeType: "S",
      },
      {
        AttributeName: "seq_nr",
        AttributeType: "N",
      },
    ],
    KeySchema: [
      {
        AttributeName: "pkey",
        KeyType: "HASH",
      },
      {
        AttributeName: "skey",
        KeyType: "RANGE",
      },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: indexName,
        KeySchema: [
          {
            AttributeName: "aid",
            KeyType: "HASH",
          },
          {
            AttributeName: "seq_nr",
            KeyType: "RANGE",
          },
        ],
        Projection: {
          ProjectionType: "ALL",
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 10,
          WriteCapacityUnits: 5,
        },
      },
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 10,
      WriteCapacityUnits: 5,
    },
  };

  await dynamodbClient.send(new CreateTableCommand(request));
}

export { createDynamoDBClient, createJournalTable, createSnapshotTable };
