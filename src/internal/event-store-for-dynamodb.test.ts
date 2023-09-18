import {
  GenericContainer,
  StartedTestContainer,
  TestContainer,
  Wait,
} from "testcontainers";
import { describe } from "node:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventStoreForDynamoDB } from "./event-store-for-dynamodb";
import { ulid } from "ulid";
import { UserAccountId } from "./test/user-account-id";
import { convertJSONToUserAccount, UserAccount } from "./test/user-account";
import { UserAccountEvent } from "./test/user-account-event";
import {
  createDynamoDBClient,
  createJournalTable,
  createSnapshotTable,
} from "./test/dynamodb-utils";

afterEach(() => {
  jest.useRealTimers();
  const TEST_TIME_FACTOR = parseFloat(process.env.TEST_TIME_FACTOR ?? "1.0");
  const TIMEOUT: number = 5 * 1000 * TEST_TIME_FACTOR;
  console.log("TIMEOUT = ", TIMEOUT);
  jest.setTimeout(TIMEOUT);
});

describe("EventStoreForDynamoDB", () => {
  let container: TestContainer;
  let startedContainer: StartedTestContainer;
  let eventStore: EventStoreForDynamoDB<
    UserAccountId,
    UserAccount,
    UserAccountEvent
  >;

  const JOURNAL_TABLE_NAME = "journal";
  const SNAPSHOT_TABLE_NAME = "snapshot";
  const JOURNAL_AID_INDEX_NAME = "journal-aid-index";
  const SNAPSHOTS_AID_INDEX_NAME = "snapshots-aid-index";

  function createEventStore(
    dynamodbClient: DynamoDBClient,
  ): EventStoreForDynamoDB<UserAccountId, UserAccount, UserAccountEvent> {
    return new EventStoreForDynamoDB<
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
    const dynamodbClient = createDynamoDBClient(startedContainer);
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
    eventStore = createEventStore(dynamodbClient);
  });

  afterAll(async () => {
    if (startedContainer !== undefined) {
      await startedContainer.stop();
    }
  });

  test("persistAndSnapshot", async () => {
    const id = new UserAccountId(ulid());
    const name = "Alice";
    const [userAccount1, created] = UserAccount.create(id, name);

    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const userAccount2Result = await eventStore.getLatestSnapshotById(
      id,
      convertJSONToUserAccount,
    );
    if (userAccount2Result === undefined) {
      throw new Error("userAccount2 is undefined");
    }
    const [userAccount2] = userAccount2Result;
    expect(userAccount2.id).toEqual(id);
    expect(userAccount2.name).toEqual(name);
    expect(userAccount2.version).toEqual(1);
  });

  test("persistAndSnapshot2", async () => {
    const id = new UserAccountId(ulid());
    const name = "Alice";
    const [userAccount1, created] = UserAccount.create(id, name);

    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const [userAccount2, renamed] = userAccount1.rename("Bob");

    await eventStore.persistEvent(renamed, userAccount2.version);

    const userAccount3Result = await eventStore.getLatestSnapshotById(
      id,
      convertJSONToUserAccount,
    );
    if (userAccount3Result === undefined) {
      throw new Error("userAccount2 is undefined");
    }
    const [userAccount3] = userAccount3Result;

    expect(userAccount3.id).toEqual(id);
    expect(userAccount3.name).toEqual(name);
    expect(userAccount3.sequenceNumber).toEqual(1);
    expect(userAccount3.version).toEqual(1);
  });
});
