import { randomUUID } from "node:crypto";
import { CreateTableCommand, type CreateTableCommandInput, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GenericContainer, Wait } from "testcontainers";

export async function startDynamoDBContainer(): Promise<{ client: DynamoDBClient; stop(): Promise<void> }> {
  const container = await new GenericContainer("amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab")
    .withExposedPorts(8000).withWaitStrategy(Wait.forListeningPorts()).withStartupTimeout(90000).start();
  const client = new DynamoDBClient({
    region: "us-west-1", endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
    credentials: { accessKeyId: "dynamodblocal", secretAccessKey: "test-only" }, maxAttempts: 1,
  });
  return { client, stop: async () => { client.destroy(); await container.stop(); } };
}

export async function createEventStoreTables(client: DynamoDBClient) {
  const prefix = `example-${randomUUID()}`;
  const tables = { journal: `${prefix}-journal`, snapshot: `${prefix}-snapshot`, head: `${prefix}-head` };
  const snapshotAidIndexName = "snapshot-aid-history";
  const definitions: CreateTableCommandInput[] = [
    {
      TableName: tables.journal, BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "aid", AttributeType: "S" }, { AttributeName: "seq_nr", AttributeType: "N" }],
      KeySchema: [{ AttributeName: "aid", KeyType: "HASH" }, { AttributeName: "seq_nr", KeyType: "RANGE" }],
    },
    {
      TableName: tables.snapshot, BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "aid", AttributeType: "S" }, { AttributeName: "skey", AttributeType: "N" }, { AttributeName: "active_history_seq_nr", AttributeType: "N" }],
      KeySchema: [{ AttributeName: "aid", KeyType: "HASH" }, { AttributeName: "skey", KeyType: "RANGE" }],
      GlobalSecondaryIndexes: [{ IndexName: snapshotAidIndexName,
        KeySchema: [{ AttributeName: "aid", KeyType: "HASH" }, { AttributeName: "active_history_seq_nr", KeyType: "RANGE" }],
        Projection: { ProjectionType: "KEYS_ONLY" } }],
    },
    {
      TableName: tables.head, BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "aid", AttributeType: "S" }], KeySchema: [{ AttributeName: "aid", KeyType: "HASH" }],
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" },
    },
  ];
  for (const definition of definitions) await client.send(new CreateTableCommand(definition));
  return { tables, snapshotAidIndexName };
}
