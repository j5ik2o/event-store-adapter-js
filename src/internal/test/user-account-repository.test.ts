import { describe } from "node:test";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GenericContainer,
  type StartedTestContainer,
  type TestContainer,
  Wait,
} from "testcontainers";
import { ulid } from "ulid";
import { type EventStore, EventStoreFactory } from "../../event-store";
import {
  createDynamoDBClient,
  createJournalTable,
  createSnapshotTable,
} from "./dynamodb-utils";
import { convertJSONToUserAccount, UserAccount } from "./user-account";
import {
  convertJSONtoUserAccountEvent,
  type UserAccountEvent,
} from "./user-account-event";
import { UserAccountId } from "./user-account-id";
import { UserAccountRepository } from "./user-account-repository";

afterEach(() => {
  jest.useRealTimers();
});

describe("UserAccountRepository", () => {
  const TEST_TIME_FACTOR = Number.parseFloat(
    process.env.TEST_TIME_FACTOR ?? "1.0",
  );
  const TIMEOUT: number = 10 * 1000 * TEST_TIME_FACTOR;

  let container: TestContainer;
  let startedContainer: StartedTestContainer;
  let eventStore: EventStore<UserAccountId, UserAccount, UserAccountEvent>;

  const JOURNAL_TABLE_NAME = "journal";
  const SNAPSHOT_TABLE_NAME = "snapshot";
  const JOURNAL_AID_INDEX_NAME = "journal-aid-index";
  const SNAPSHOTS_AID_INDEX_NAME = "snapshots-aid-index";

  function createEventStore(
    dynamodbClient: DynamoDBClient,
  ): EventStore<UserAccountId, UserAccount, UserAccountEvent> {
    return EventStoreFactory.ofDynamoDB<
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
      convertJSONtoUserAccountEvent,
      convertJSONToUserAccount,
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
  }, TIMEOUT);

  afterAll(async () => {
    if (startedContainer !== undefined) {
      await startedContainer.stop();
    }
  }, TIMEOUT);

  test(
    "storeAndFindById",
    async () => {
      const userAccountRepository = new UserAccountRepository(eventStore);

      const id = new UserAccountId(ulid());
      const name = "Alice";
      const [userAccount1, created] = UserAccount.create(id, name);

      await userAccountRepository.storeEventAndSnapshot(created, userAccount1);

      const [userAccount2, renamed] = userAccount1.rename("Bob");

      await userAccountRepository.storeEvent(renamed, userAccount2.version);

      const userAccount3 = await userAccountRepository.findById(id);
      if (userAccount3 === undefined) {
        throw new Error("userAccount3 is undefined");
      }

      expect(userAccount3.id).toEqual(id);
      expect(userAccount3.name).toEqual("Bob");
      expect(userAccount3.sequenceNumber).toEqual(2);
      expect(userAccount3.version).toEqual(2);
    },
    TIMEOUT,
  );
});
