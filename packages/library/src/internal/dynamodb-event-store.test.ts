import {
  type DynamoDBClient,
  QueryCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GenericContainer,
  type StartedTestContainer,
  type TestContainer,
  Wait,
} from "testcontainers";
import { ulid } from "ulid";
import { ShardId } from "../shard-id";
import type {
  EventSerializer,
  EventStore,
  EventStoreError,
  Logger,
  Result,
  ShardSelector,
  SnapshotSerializer,
} from "../types";
import { createDynamoDBEventStore } from "./dynamodb-event-store";
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
    options: {
      shardCount?: number;
      shardSelector?: ShardSelector<UserAccountId>;
    } = {},
  ): EventStore<UserAccountId, UserAccount, UserAccountEvent> {
    return createDynamoDBEventStore<
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
      keepSnapshotCount,
      ...options,
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
      createDynamoDBEventStore<UserAccountId, UserAccount, UserAccountEvent>({
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
      createDynamoDBEventStore<UserAccountId, UserAccount, UserAccountEvent>(
        input,
      );
    }).toThrow("must be a function");
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid shardCount %s", (shardCount) => {
    expect(() => {
      createEventStore(dynamodbClient, undefined, {
        shardCount,
      });
    }).toThrow("Invalid shardCount configuration");
  });

  test(
    "uses custom shard selector for DynamoDB keys",
    async () => {
      const shardSelector: ShardSelector<UserAccountId> = {
        selectShardId: jest.fn(() => ShardId.create(7)),
      };
      const eventStore = createEventStore(dynamodbClient, undefined, {
        shardSelector,
      });
      const id = UserAccountId.create(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");

      await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

      const result = await dynamodbClient.send(
        new QueryCommand({
          TableName: JOURNAL_TABLE_NAME,
          KeyConditionExpression: "#pkey = :pkey AND #skey = :skey",
          ExpressionAttributeNames: {
            "#pkey": "pkey",
            "#skey": "skey",
          },
          ExpressionAttributeValues: {
            ":pkey": { S: "user-account-7" },
            ":skey": { S: `${id.asString()}-1` },
          },
        }),
      );
      expect(result.Items).toHaveLength(1);
      expect(result.Items?.[0].pkey).toEqual({ S: "user-account-7" });
      expect(shardSelector.selectShardId).toHaveBeenCalledWith(id, 32);
    },
    TIMEOUT,
  );

  test(
    "persists redundant snapshots when retention is enabled",
    async () => {
      const retainedEventStore = createEventStore(dynamodbClient, 1);
      const id = UserAccountId.create(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");

      await expectOk(
        retainedEventStore.persistEventAndSnapshot(created, userAccount1),
      );

      const [userAccount2, renamed] = userAccount1.rename("Bob");
      await expectOk(
        retainedEventStore.persistEventAndSnapshot(renamed, userAccount2),
      );

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

describe("DynamoDBEventStore failure mapping", () => {
  const snapshotPayload = new TextEncoder().encode(
    JSON.stringify({
      type: "UserAccount",
      data: {
        typeName: "UserAccount",
        id: { typeName: "user-account", value: "1" },
        name: "Alice",
        sequenceNumber: 1,
        version: 1,
      },
    }),
  );

  test("rejects journal rows without payloads", async () => {
    const eventStore = createUnitEventStore(async (command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return { Items: [{}] };
    });

    await expect(
      eventStore.getEventsByIdSinceSequenceNumber(UserAccountId.create("1"), 1),
    ).rejects.toThrow("Payload is undefined");
  });

  test("rejects snapshot rows without versions", async () => {
    const eventStore = createUnitEventStore(async (command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return { Items: [{ payload: { B: snapshotPayload } }] };
    });

    await expect(
      eventStore.getLatestSnapshotById(UserAccountId.create("1")),
    ).rejects.toThrow("Version is undefined");
  });

  test("rejects snapshot rows without payloads", async () => {
    const eventStore = createUnitEventStore(async (command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return { Items: [{ version: { N: "1" } }] };
    });

    await expect(
      eventStore.getLatestSnapshotById(UserAccountId.create("1")),
    ).rejects.toThrow("Payload is undefined");
  });

  test("converts DynamoDB write failures to storage errors", async () => {
    const cause = new Error("write failed");
    const eventStore = createUnitEventStore(async (command) => {
      expect(command).toBeInstanceOf(TransactWriteItemsCommand);
      throw cause;
    });
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");

    await expectErr(
      eventStore.persistEventAndSnapshot(created, userAccount),
      "storage-error",
      cause,
    );
  });

  test("converts serializer failures before DynamoDB writes to serialization errors", async () => {
    const cause = new Error("snapshot serialization failed");
    const eventStore = createUnitEventStore(
      async () => {
        throw new Error("send should not be called");
      },
      undefined,
      {
        snapshotSerializer: {
          serialize: jest.fn(() => {
            throw cause;
          }),
          deserialize: jest.fn(),
        },
      },
    );
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");

    await expectErr(
      eventStore.persistEventAndSnapshot(created, userAccount),
      "serialization-error",
      cause,
    );
  });

  test("converts event serializer failures before DynamoDB updates to serialization errors", async () => {
    const cause = new Error("event serialization failed");
    const eventStore = createUnitEventStore(
      async () => {
        throw new Error("send should not be called");
      },
      undefined,
      {
        eventSerializer: {
          serialize: jest.fn(() => {
            throw cause;
          }),
          deserialize: jest.fn(),
        },
      },
    );
    const id = UserAccountId.create("1");
    const [aggregate] = UserAccount.create(id, "Alice");
    const [renamedAggregate, renamed] = aggregate.rename("Bob");

    await expectErr(
      eventStore.persistEvent(renamed, renamedAggregate.version),
      "serialization-error",
      cause,
    );
  });

  test("does not convert shard selector failures to serialization errors", async () => {
    const cause = new Error("shard selection failed");
    const eventStore = createUnitEventStore(
      async () => {
        throw new Error("send should not be called");
      },
      undefined,
      {
        shardSelector: {
          selectShardId: jest.fn(() => {
            throw cause;
          }),
        },
      },
    );
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");

    await expect(
      eventStore.persistEventAndSnapshot(created, userAccount),
    ).rejects.toThrow(cause);
  });

  test("does not convert update shard selector failures to serialization errors", async () => {
    const cause = new Error("update shard selection failed");
    const eventStore = createUnitEventStore(
      async () => {
        throw new Error("send should not be called");
      },
      undefined,
      {
        shardSelector: {
          selectShardId: jest.fn(() => {
            throw cause;
          }),
        },
      },
    );
    const id = UserAccountId.create("1");
    const [aggregate] = UserAccount.create(id, "Alice");
    const [renamedAggregate, renamed] = aggregate.rename("Bob");

    await expect(
      eventStore.persistEvent(renamed, renamedAggregate.version),
    ).rejects.toThrow(cause);
  });

  test("returns snapshot retention errors after update writes", async () => {
    const cause = new Error("retention query failed");
    const eventStore = createUnitEventStore(async (command) => {
      if (command instanceof TransactWriteItemsCommand) {
        return {};
      }
      if (command instanceof QueryCommand) {
        throw cause;
      }
      throw new Error("unexpected command");
    }, 1);
    const id = UserAccountId.create("1");
    const [aggregate] = UserAccount.create(id, "Alice");
    const [renamedAggregate, renamed] = aggregate.rename("Bob");

    await expectErr(
      eventStore.persistEvent(renamed, renamedAggregate.version),
      "storage-error",
      cause,
    );
  });

  test("returns snapshot retention errors after snapshot writes", async () => {
    const cause = new Error("retention query failed");
    const eventStore = createUnitEventStore(async (command) => {
      if (command instanceof TransactWriteItemsCommand) {
        return {};
      }
      if (command instanceof QueryCommand) {
        throw cause;
      }
      throw new Error("unexpected command");
    }, 1);
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");

    await expectErr(
      eventStore.persistEventAndSnapshot(created, userAccount),
      "storage-error",
      cause,
    );
  });

  test("uses optional collaborators on successful operations", async () => {
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");
    const [renamedAggregate, renamed] = userAccount.rename("Bob");
    const logger: Logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const eventSerializer: EventSerializer<UserAccountId, UserAccountEvent> = {
      serialize: jest.fn(() => new Uint8Array([1])),
      deserialize: jest.fn(() => renamed),
    };
    const snapshotSerializer: SnapshotSerializer<UserAccountId, UserAccount> = {
      serialize: jest.fn(() => new Uint8Array([2])),
      deserialize: jest.fn(() => renamedAggregate),
    };
    const eventStore = createUnitEventStore(
      async (command) => {
        if (command instanceof TransactWriteItemsCommand) {
          return {};
        }
        if (command instanceof QueryCommand) {
          const tableName = command.input.TableName;
          if (tableName === "journal") {
            return { Items: [{ payload: { B: new Uint8Array([1]) } }] };
          }
          return {
            Items: [
              { version: { N: "2" }, payload: { B: new Uint8Array([2]) } },
            ],
          };
        }
        throw new Error("unexpected command");
      },
      undefined,
      {
        eventSerializer,
        logger,
        snapshotSerializer,
      },
    );

    await expectOk(eventStore.persistEvent(renamed, renamedAggregate.version));
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount));
    await expect(
      eventStore.getEventsByIdSinceSequenceNumber(id, 1),
    ).resolves.toEqual([renamed]);
    const latestSnapshot = await eventStore.getLatestSnapshotById(id);

    expect(latestSnapshot?.name).toBe("Bob");
    expect(latestSnapshot?.version).toBe(2);
    expect(logger.debug).toHaveBeenCalled();
    expect(eventSerializer.serialize).toHaveBeenCalled();
    expect(eventSerializer.deserialize).toHaveBeenCalled();
    expect(snapshotSerializer.serialize).toHaveBeenCalled();
    expect(snapshotSerializer.deserialize).toHaveBeenCalled();
  });

  test("writes full epoch milliseconds to DynamoDB timestamps", async () => {
    let requestInput: TransactWriteItemsCommand["input"] | undefined;
    const eventStore = createUnitEventStore(async (command) => {
      if (command instanceof TransactWriteItemsCommand) {
        requestInput = command.input;
        return {};
      }
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      throw new Error("unexpected command");
    }, 1);
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");
    const occurredAt = new Date("2026-05-24T12:34:56.789Z");
    const createdAtFixedTime = {
      ...created,
      occurredAt,
    };

    await expectOk(
      eventStore.persistEventAndSnapshot(createdAtFixedTime, userAccount),
    );

    const transactItems = requestInput?.TransactItems;
    expect(transactItems?.[0].Put?.Item?.last_updated_at).toEqual({
      N: occurredAt.getTime().toString(),
    });
    expect(transactItems?.[1].Put?.Item?.occurred_at).toEqual({
      N: occurredAt.getTime().toString(),
    });
    expect(transactItems?.[2].Put?.Item?.last_updated_at).toEqual({
      N: occurredAt.getTime().toString(),
    });
  });

  test("skips redundant snapshot writes when keepSnapshotCount is zero", async () => {
    let requestInput: TransactWriteItemsCommand["input"] | undefined;
    const eventStore = createUnitEventStore(async (command) => {
      if (command instanceof TransactWriteItemsCommand) {
        requestInput = command.input;
        return {};
      }
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      throw new Error("unexpected command");
    }, 0);
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");

    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount));

    expect(requestInput?.TransactItems).toHaveLength(2);
  });

  test("rejects invalid keepSnapshotCount at construction", () => {
    expect(() =>
      createUnitEventStore(async () => {
        throw new Error("send should not be called");
      }, Number.NaN),
    ).toThrow("Invalid keepSnapshotCount configuration: must be finite");
  });

  test("returns an empty event list when DynamoDB returns no rows", async () => {
    const eventStore = createUnitEventStore(async (command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return {};
    });

    await expect(
      eventStore.getEventsByIdSinceSequenceNumber(UserAccountId.create("1"), 1),
    ).resolves.toEqual([]);
  });

  test("converts transaction cancellations without reasons to storage errors", async () => {
    const cause = new TransactionCanceledException({
      $metadata: {},
      message: "cancelled",
    });
    const eventStore = createUnitEventStore(async (command) => {
      expect(command).toBeInstanceOf(TransactWriteItemsCommand);
      throw cause;
    });
    const id = UserAccountId.create("1");
    const [userAccount, created] = UserAccount.create(id, "Alice");

    await expectErr(
      eventStore.persistEventAndSnapshot(created, userAccount),
      "storage-error",
      cause,
    );
  });
});

function createUnitEventStore(
  send: (command: unknown) => Promise<unknown>,
  keepSnapshotCount?: number,
  options: {
    eventSerializer?: EventSerializer<UserAccountId, UserAccountEvent>;
    logger?: Logger;
    shardSelector?: ShardSelector<UserAccountId>;
    snapshotSerializer?: SnapshotSerializer<UserAccountId, UserAccount>;
  } = {},
): EventStore<UserAccountId, UserAccount, UserAccountEvent> {
  return createDynamoDBEventStore<UserAccountId, UserAccount, UserAccountEvent>(
    {
      client: { send } as unknown as DynamoDBClient,
      journalTableName: "journal",
      snapshotTableName: "snapshot",
      journalAidIndexName: "journal-aid-index",
      snapshotAidIndexName: "snapshot-aid-index",
      snapshotActiveTtlIndexName: "snapshot-active-ttl-index",
      shardCount: 32,
      eventConverter: convertJSONtoUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
      keepSnapshotCount,
      ...options,
    },
  );
}

async function expectOk(
  resultPromise: Promise<Result<void, EventStoreError>>,
): Promise<void> {
  const result = await resultPromise;
  expect(result).toEqual({ type: "ok", value: undefined });
}

async function expectErr(
  resultPromise: Promise<Result<void, EventStoreError>>,
  type: EventStoreError["type"],
  cause?: unknown,
): Promise<void> {
  const result = await resultPromise;
  expect(result.type).toBe("err");
  if (result.type !== "err") {
    return;
  }
  expect(result.error.type).toBe(type);
  if (cause !== undefined) {
    expect(result.error.cause).toBe(cause);
  }
}
