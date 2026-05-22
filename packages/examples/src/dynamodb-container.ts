import {
  CreateTableCommand,
  type CreateTableCommandInput,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GenericContainer,
  type StartedTestContainer,
  type TestContainer,
  Wait,
} from "testcontainers";

const DYNAMODB_PORT = 4566;

async function startDynamoDBContainer(): Promise<{
  client: DynamoDBClient;
  stop: () => Promise<void>;
}> {
  const container = new GenericContainer("localstack/localstack:2.1.0")
    .withEnvironment({
      SERVICES: "dynamodb",
      DEFAULT_REGION: "us-west-1",
      EAGER_SERVICE_LOADING: "1",
      DYNAMODB_SHARED_DB: "1",
      DYNAMODB_IN_MEMORY: "1",
    })
    .withWaitStrategy(Wait.forLogMessage("Ready."))
    .withExposedPorts(DYNAMODB_PORT);
  const startedContainer = await container.start();
  const client = createDynamoDBClient(startedContainer);
  return {
    client,
    stop: async () => {
      await startedContainer.stop();
    },
  };
}

function createDynamoDBClient(
  startedContainer: StartedTestContainer,
): DynamoDBClient {
  return new DynamoDBClient({
    region: "us-west-1",
    endpoint: `http://localhost:${startedContainer.getMappedPort(
      DYNAMODB_PORT,
    )}`,
    credentials: {
      accessKeyId: "x",
      secretAccessKey: "x",
    },
  });
}

async function createJournalTable(
  client: DynamoDBClient,
  tableName: string,
  indexName: string,
): Promise<void> {
  const request: CreateTableCommandInput = {
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: "pkey", AttributeType: "S" },
      { AttributeName: "skey", AttributeType: "S" },
      { AttributeName: "aid", AttributeType: "S" },
      { AttributeName: "seq_nr", AttributeType: "N" },
    ],
    KeySchema: [
      { AttributeName: "pkey", KeyType: "HASH" },
      { AttributeName: "skey", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: indexName,
        KeySchema: [
          { AttributeName: "aid", KeyType: "HASH" },
          { AttributeName: "seq_nr", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
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
  await client.send(new CreateTableCommand(request));
}

async function createSnapshotTable(
  client: DynamoDBClient,
  tableName: string,
  indexName: string,
  activeTtlIndexName: string,
): Promise<void> {
  const request: CreateTableCommandInput = {
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: "pkey", AttributeType: "S" },
      { AttributeName: "skey", AttributeType: "S" },
      { AttributeName: "aid", AttributeType: "S" },
      { AttributeName: "seq_nr", AttributeType: "N" },
      { AttributeName: "active_ttl_seq_nr", AttributeType: "N" },
    ],
    KeySchema: [
      { AttributeName: "pkey", KeyType: "HASH" },
      { AttributeName: "skey", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: indexName,
        KeySchema: [
          { AttributeName: "aid", KeyType: "HASH" },
          { AttributeName: "seq_nr", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
        ProvisionedThroughput: {
          ReadCapacityUnits: 10,
          WriteCapacityUnits: 5,
        },
      },
      {
        IndexName: activeTtlIndexName,
        KeySchema: [
          { AttributeName: "aid", KeyType: "HASH" },
          { AttributeName: "active_ttl_seq_nr", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "KEYS_ONLY" },
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
  await client.send(new CreateTableCommand(request));
}

export {
  createJournalTable,
  createSnapshotTable,
  startDynamoDBContainer,
  type TestContainer,
};
