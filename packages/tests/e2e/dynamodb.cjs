const { randomUUID } = require("node:crypto");
const { CreateTableCommand, DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { GenericContainer, Wait } = require("testcontainers");

async function withDynamoDB(run) {
  const container = await new GenericContainer("amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab")
    .withExposedPorts(8000).withWaitStrategy(Wait.forListeningPorts()).withStartupTimeout(90000).start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(8000)}`;
  const client = new DynamoDBClient({ region: "us-west-1", endpoint, credentials: { accessKeyId: "dynamodblocal", secretAccessKey: "test-only" }, maxAttempts: 1 });
  try {
    const prefix = `package-${randomUUID()}`;
    const tables = { journal: `${prefix}-journal`, snapshot: `${prefix}-snapshot`, head: `${prefix}-head` };
    const snapshotAidIndexName = "snapshot-history";
    for (const [name, sort] of [["journal", "seq_nr"], ["snapshot", "skey"], ["head", null]]) {
      await client.send(new CreateTableCommand({
        TableName: tables[name], BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "aid", AttributeType: "S" }, ...(sort === null ? [] : [{ AttributeName: sort, AttributeType: "N" }]), ...(name === "snapshot" ? [{ AttributeName: "active_history_seq_nr", AttributeType: "N" }] : [])],
        KeySchema: [{ AttributeName: "aid", KeyType: "HASH" }, ...(sort === null ? [] : [{ AttributeName: sort, KeyType: "RANGE" }])],
        ...(name === "snapshot" ? { GlobalSecondaryIndexes: [{ IndexName: snapshotAidIndexName, KeySchema: [{ AttributeName: "aid", KeyType: "HASH" }, { AttributeName: "active_history_seq_nr", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }] } : {}),
        ...(name === "head" ? { StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" } } : {}),
      }));
    }
    return await run({ endpoint, tables, snapshotAidIndexName });
  } finally { client.destroy(); await container.stop(); }
}
module.exports = { withDynamoDB };
