import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GenericContainer,
  type StartedTestContainer,
  type TestContainer,
  Wait,
} from "testcontainers";
import { ulid } from "ulid";
import {
  EventStore,
  type EventStore as EventStoreType,
} from "../../event-store";
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
  let eventStore: EventStoreType<UserAccountId, UserAccount, UserAccountEvent>;

  const JOURNAL_TABLE_NAME = "journal";
  const SNAPSHOT_TABLE_NAME = "snapshot";
  const JOURNAL_AID_INDEX_NAME = "journal-aid-index";
  const SNAPSHOTS_AID_INDEX_NAME = "snapshots-aid-index";
  const SNAPSHOTS_ACTIVE_TTL_INDEX_NAME = "snapshots-active-ttl-index";

  function createEventStore(
    dynamodbClient: DynamoDBClient,
  ): EventStoreType<UserAccountId, UserAccount, UserAccountEvent> {
    return EventStore.createDynamoDB<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      client: dynamodbClient,
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
      journalAidIndexName: JOURNAL_AID_INDEX_NAME,
      snapshotAidIndexName: SNAPSHOTS_AID_INDEX_NAME,
      snapshotActiveTtlIndexName: SNAPSHOTS_ACTIVE_TTL_INDEX_NAME,
      shardCount: 32,
      eventConverter: convertJSONtoUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
    });
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
      SNAPSHOTS_ACTIVE_TTL_INDEX_NAME,
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
      const userAccountRepository = UserAccountRepository.create(eventStore);

      const id = UserAccountId.create(ulid());
      const name = "Alice";
      const [userAccount1, created] = UserAccount.create(id, name);

      await expect(
        userAccountRepository.storeEventAndSnapshot(created, userAccount1),
      ).resolves.toEqual({
        type: "ok",
        value: undefined,
      });

      const [userAccount2, renamed] = userAccount1.rename("Bob");

      await expect(
        userAccountRepository.storeEvent(renamed, userAccount2.version),
      ).resolves.toEqual({
        type: "ok",
        value: undefined,
      });

      const userAccount3 = await userAccountRepository.findById(id);
      if (userAccount3 === undefined) {
        throw new Error("userAccount3 is undefined");
      }

      expect(userAccount3.id.asString()).toEqual(id.asString());
      expect(userAccount3.name).toEqual("Bob");
      expect(userAccount3.sequenceNumber).toEqual(2);
      expect(userAccount3.version).toEqual(2);
    },
    TIMEOUT,
  );
});
