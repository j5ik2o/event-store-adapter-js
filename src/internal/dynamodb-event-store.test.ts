import { type DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import {
  GenericContainer,
  type StartedTestContainer,
  type TestContainer,
  Wait,
} from "testcontainers";
import { ulid } from "ulid";
import { DynamoDBEventStore } from "./dynamodb-event-store";
import {
  createDynamoDBClient,
  createJournalTable,
  createSnapshotTable,
} from "./test/dynamodb-utils";
import { runEventStoreContractTests } from "./test/event-store-contract";
import { convertJSONToUserAccount, UserAccount } from "./test/user-account";
import {
  convertJSONtoUserAccountEvent,
  type UserAccountEvent,
} from "./test/user-account-event";
import { UserAccountId } from "./test/user-account-id";

afterEach(() => {
  jest.useRealTimers();
});

describe("DynamoDBEventStore", () => {
  const TEST_TIME_FACTOR = Number.parseFloat(
    process.env.TEST_TIME_FACTOR ?? "1.0",
  );
  const TIMEOUT: number = 10 * 1000 * TEST_TIME_FACTOR;

  let container: TestContainer;
  let startedContainer: StartedTestContainer;
  let dynamodbClient: DynamoDBClient;

  const JOURNAL_TABLE_NAME = "journal";
  const SNAPSHOT_TABLE_NAME = "snapshot";
  const JOURNAL_AID_INDEX_NAME = "journal-aid-index";
  const SNAPSHOTS_AID_INDEX_NAME = "snapshots-aid-index";
  const SNAPSHOTS_ACTIVE_TTL_INDEX_NAME = "snapshots-active-ttl-index";

  function createEventStore(
    dynamodbClient: DynamoDBClient,
    keepSnapshotCount?: number,
  ): DynamoDBEventStore<UserAccountId, UserAccount, UserAccountEvent> {
    return new DynamoDBEventStore<UserAccountId, UserAccount, UserAccountEvent>(
      {
        client: dynamodbClient,
        journalTableName: JOURNAL_TABLE_NAME,
        snapshotTableName: SNAPSHOT_TABLE_NAME,
        journalAidIndexName: JOURNAL_AID_INDEX_NAME,
        snapshotAidIndexName: SNAPSHOTS_AID_INDEX_NAME,
        snapshotActiveTtlIndexName: SNAPSHOTS_ACTIVE_TTL_INDEX_NAME,
        shardCount: 32,
        eventConverter: convertJSONtoUserAccountEvent,
        snapshotConverter: convertJSONToUserAccount,
        keepSnapshotCount,
      },
    );
  }

  beforeAll(async () => {
    container = new GenericContainer("localstack/localstack:2.1.0")
      .withEnvironment({
        SERVICES: "dynamodb",
        DEFAULT_REGION: "us-west-1",
        EAGER_SERVICE_LOADING: "1",
        DYNAMODB_SHARED_DB: "1",
        DYNAMODB_IN_MEMORY: "1",
      })
      .withWaitStrategy(Wait.forLogMessage("Ready."))
      .withExposedPorts(4566);
    startedContainer = await container.start();
    dynamodbClient = createDynamoDBClient(startedContainer);
    await createJournalTable(
      dynamodbClient,
      JOURNAL_TABLE_NAME,
      JOURNAL_AID_INDEX_NAME,
    );
    await createSnapshotTable(
      dynamodbClient,
      SNAPSHOT_TABLE_NAME,
      SNAPSHOTS_AID_INDEX_NAME,
      SNAPSHOTS_ACTIVE_TTL_INDEX_NAME,
    );
  }, TIMEOUT);

  afterAll(async () => {
    if (startedContainer !== undefined) {
      await startedContainer.stop();
    }
  }, TIMEOUT);

  runEventStoreContractTests({
    name: "DynamoDBEventStore contract",
    timeout: TIMEOUT,
    createEventStore: () => createEventStore(dynamodbClient),
  });

  test.each([
    [
      Number.NaN,
      "Invalid deleteTtlMillis configuration: deleteTtlMillis must be finite, got NaN",
    ],
    [
      Number.POSITIVE_INFINITY,
      "Invalid deleteTtlMillis configuration: deleteTtlMillis must be finite, got Infinity",
    ],
    [
      -1,
      "Invalid deleteTtlMillis configuration: deleteTtlMillis must be non-negative, got -1",
    ],
    [
      -0,
      "Invalid deleteTtlMillis configuration: deleteTtlMillis must be non-negative, got -0",
    ],
  ])("rejects invalid deleteTtlMillis %s", (deleteTtlMillis, message) => {
    expect(() => {
      new DynamoDBEventStore<UserAccountId, UserAccount, UserAccountEvent>({
        client: {} as DynamoDBClient,
        journalTableName: JOURNAL_TABLE_NAME,
        snapshotTableName: SNAPSHOT_TABLE_NAME,
        journalAidIndexName: JOURNAL_AID_INDEX_NAME,
        snapshotAidIndexName: SNAPSHOTS_AID_INDEX_NAME,
        snapshotActiveTtlIndexName: SNAPSHOTS_ACTIVE_TTL_INDEX_NAME,
        shardCount: 32,
        eventConverter: convertJSONtoUserAccountEvent,
        snapshotConverter: convertJSONToUserAccount,
        deleteTtlMillis,
      });
    }).toThrow(message);
  });

  test.each([
    ["eventConverter", undefined],
    ["snapshotConverter", undefined],
  ])("rejects invalid %s", (converterName, converter) => {
    const input = {
      client: {} as DynamoDBClient,
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
      journalAidIndexName: JOURNAL_AID_INDEX_NAME,
      snapshotAidIndexName: SNAPSHOTS_AID_INDEX_NAME,
      snapshotActiveTtlIndexName: SNAPSHOTS_ACTIVE_TTL_INDEX_NAME,
      shardCount: 32,
      eventConverter: convertJSONtoUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
      [converterName]: converter,
    };

    expect(() => {
      new DynamoDBEventStore<UserAccountId, UserAccount, UserAccountEvent>(
        input,
      );
    }).toThrow("must be a function");
  });

  test(
    "persists redundant snapshots when retention is enabled",
    async () => {
      const retainedEventStore = createEventStore(dynamodbClient, 1);
      const id = new UserAccountId(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");

      await retainedEventStore.persistEventAndSnapshot(created, userAccount1);

      const [userAccount2, renamed] = userAccount1.rename("Bob");
      await retainedEventStore.persistEventAndSnapshot(renamed, userAccount2);

      const result = await dynamodbClient.send(
        new QueryCommand({
          TableName: SNAPSHOT_TABLE_NAME,
          IndexName: SNAPSHOTS_AID_INDEX_NAME,
          KeyConditionExpression: "#aid = :aid AND #seq_nr > :seq_nr",
          ExpressionAttributeNames: {
            "#aid": "aid",
            "#seq_nr": "seq_nr",
          },
          ExpressionAttributeValues: {
            ":aid": { S: id.asString() },
            ":seq_nr": { N: "0" },
          },
        }),
      );

      expect(result.Items).toHaveLength(1);
      expect(result.Items?.[0].seq_nr).toEqual({ N: "2" });
      expect(result.Items?.[0].active_ttl_seq_nr).toEqual({ N: "2" });

      const latestSnapshotResult = await dynamodbClient.send(
        new QueryCommand({
          TableName: SNAPSHOT_TABLE_NAME,
          IndexName: SNAPSHOTS_AID_INDEX_NAME,
          KeyConditionExpression: "#aid = :aid AND #seq_nr = :seq_nr",
          ExpressionAttributeNames: {
            "#aid": "aid",
            "#seq_nr": "seq_nr",
          },
          ExpressionAttributeValues: {
            ":aid": { S: id.asString() },
            ":seq_nr": { N: "0" },
          },
        }),
      );
      expect(latestSnapshotResult.Items).toHaveLength(1);
      expect(latestSnapshotResult.Items?.[0].active_ttl_seq_nr).toBeUndefined();
    },
    TIMEOUT,
  );
});
