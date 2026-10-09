import { randomUUID } from "node:crypto";
import {
  type AttributeValue,
  CreateTableCommand,
  type CreateTableCommandInput,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

type Tables = Readonly<{ journal: string; snapshot: string; head: string }>;

export class DynamoDBLocal {
  static readonly image =
    "amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab";
  readonly observer: DynamoDBClient;
  private clients: DynamoDBClient[] = [];
  private tableNames: string[] = [];

  private constructor(private readonly container: StartedTestContainer) {
    this.observer = this.createClient();
  }

  static async start(): Promise<DynamoDBLocal> {
    const container = await new GenericContainer(DynamoDBLocal.image)
      .withExposedPorts(8000)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(90_000)
      .start();
    return new DynamoDBLocal(container);
  }

  createClient(): DynamoDBClient {
    const client = new DynamoDBClient({
      region: "us-west-1",
      endpoint: `http://${this.container.getHost()}:${this.container.getMappedPort(8000)}`,
      credentials: {
        accessKeyId: "dynamodblocal",
        secretAccessKey: "test-only",
      },
      maxAttempts: 1,
    });
    this.clients = [...this.clients, client];
    return client;
  }

  async createTables() {
    const prefix = `configuration-${randomUUID()}`;
    const tables = Object.freeze({
      journal: `${prefix}-journal`,
      snapshot: `${prefix}-snapshot`,
      head: `${prefix}-head`,
    });
    const snapshotAidIndexName = "snapshot-aid-history";
    const definitions: CreateTableCommandInput[] = [
      {
        TableName: tables.journal,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "aid", AttributeType: "S" },
          { AttributeName: "seq_nr", AttributeType: "N" },
        ],
        KeySchema: [
          { AttributeName: "aid", KeyType: "HASH" },
          { AttributeName: "seq_nr", KeyType: "RANGE" },
        ],
      },
      {
        TableName: tables.snapshot,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "aid", AttributeType: "S" },
          { AttributeName: "skey", AttributeType: "N" },
          { AttributeName: "active_history_seq_nr", AttributeType: "N" },
        ],
        KeySchema: [
          { AttributeName: "aid", KeyType: "HASH" },
          { AttributeName: "skey", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: snapshotAidIndexName,
            KeySchema: [
              { AttributeName: "aid", KeyType: "HASH" },
              { AttributeName: "active_history_seq_nr", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "KEYS_ONLY" },
          },
        ],
      },
      {
        TableName: tables.head,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "aid", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "aid", KeyType: "HASH" }],
        StreamSpecification: {
          StreamEnabled: true,
          StreamViewType: "NEW_IMAGE",
        },
      },
    ];
    for (const definition of definitions) {
      await this.observer.send(new CreateTableCommand(definition));
      this.tableNames = [...this.tableNames, definition.TableName as string];
    }
    await this.observer.send(
      new UpdateTimeToLiveCommand({
        TableName: tables.snapshot,
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      }),
    );
    return Object.freeze({ tables, snapshotAidIndexName });
  }

  async seedConfiguration(
    tables: Tables,
    items: Partial<Record<keyof Tables, Record<string, AttributeValue>>>,
  ): Promise<void> {
    for (const name of ["journal", "snapshot", "head"] as const) {
      const item = items[name];
      if (item !== undefined) {
        await this.observer.send(
          new PutItemCommand({ TableName: tables[name], Item: item }),
        );
      }
    }
  }

  async readConfiguration(tables: Tables) {
    const entries = await Promise.all([
      this.observer.send(
        new GetItemCommand({
          TableName: tables.journal,
          Key: { aid: { S: "__config__" }, seq_nr: { N: "0" } },
          ConsistentRead: true,
        }),
      ),
      this.observer.send(
        new GetItemCommand({
          TableName: tables.snapshot,
          Key: { aid: { S: "__config__" }, skey: { N: "0" } },
          ConsistentRead: true,
        }),
      ),
      this.observer.send(
        new GetItemCommand({
          TableName: tables.head,
          Key: { aid: { S: "__config__" } },
          ConsistentRead: true,
        }),
      ),
    ]);
    return Object.freeze({
      journal: entries[0],
      snapshot: entries[1],
      head: entries[2],
    });
  }

  async stop(): Promise<void> {
    try {
      for (const tableName of this.tableNames) {
        await this.observer.send(
          new DeleteTableCommand({ TableName: tableName }),
        );
      }
    } finally {
      for (const client of this.clients) client.destroy();
      await this.container.stop();
    }
  }
}
