import {
  TestContainer,
  StartedTestContainer,
  GenericContainer,
  Wait,
} from "testcontainers";
import { describe } from "node:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventStoreForDynamoDB } from "./event-store-for-dynamodb";
import { ulid } from "ulid";
import { UserAccountId } from "./test/user-account-id";
import { UserAccount } from "./test/user-account";
import { UserAccountEvent } from "./test/user-account-event";
import { createJournalTable, createSnapshotTable } from "./test/dynamodb-utils";

describe("EventStoreForDynamoDB", () => {
  let container: TestContainer;
  let startedContainer: StartedTestContainer;

  const JOURNAL_TABLE_NAME = "journal";
  const SNAPSHOT_TABLE_NAME = "snapshot";
  const JOURNAL_AID_INDEX_NAME = "journal-aid-index";
  const SNAPSHOTS_AID_INDEX_NAME = "snapshots-aid-index";

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
  });

  afterAll(async () => {
    await startedContainer.stop();
  });

  test("persistAndSnapshot", async () => {
    const port = startedContainer.getMappedPort(4566);
    console.log(`port = ${port}`);

    const dynamodbClient: DynamoDBClient = new DynamoDBClient({
      region: "us-west-1",
      endpoint: `http://localhost:${port}`,
      credentials: {
        accessKeyId: "x",
        secretAccessKey: "x",
      },
    });

    await createJournalTable(
      dynamodbClient,
      JOURNAL_TABLE_NAME,
      JOURNAL_AID_INDEX_NAME,
    );
    await createSnapshotTable(
      dynamodbClient,
      SNAPSHOT_TABLE_NAME,
      SNAPSHOTS_AID_INDEX_NAME,
    );

    const eventStore = new EventStoreForDynamoDB<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >(
      dynamodbClient,
      JOURNAL_TABLE_NAME,
      SNAPSHOT_TABLE_NAME,
      JOURNAL_AID_INDEX_NAME,
      SNAPSHOTS_AID_INDEX_NAME,
      32,
    );

    const userAccountIdValue = ulid();
    const id = new UserAccountId(userAccountIdValue);
    const name = "Alice";
    const [userAccount1, created] = UserAccount.create(id, name);

    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const userAccount2 = await eventStore.getLatestSnapshotById(
      id,
      UserAccount.fromJSON,
    );
    if (userAccount2 === undefined) {
      throw new Error("userAccount2 is undefined");
    }

    expect(userAccount2.id).toEqual(id);
    expect(userAccount2.name).toEqual(name);
    expect(userAccount2.version).toEqual(1);

    userAccount2.rename("Bob");
  });
});
