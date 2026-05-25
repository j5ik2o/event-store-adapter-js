import type { Database, Spanner, Transaction } from "@google-cloud/spanner";
import {
  GenericContainer,
  type StartedTestContainer,
  type TestContainer,
  Wait,
} from "testcontainers";
import { ulid } from "ulid";
import { EventStore, type EventStore as EventStoreType } from "../event-store";
import { ShardId } from "../shard-id";
import {
  type EventSerializer,
  EventStoreError,
  type Logger,
  type Result,
  type ShardSelector,
  type SnapshotSerializer,
} from "../types";
import {
  createJsonEventSerializer,
  createJsonSnapshotSerializer,
} from "./default-serializer";
import { createSpannerEventStore } from "./spanner-event-store";
import { runEventStoreContractTests } from "./test/event-store-contract";
import { createSpannerDatabase } from "./test/spanner-utils";
import { convertJSONToUserAccount, UserAccount } from "./test/user-account";
import {
  convertJSONtoUserAccountEvent,
  type UserAccountEvent,
} from "./test/user-account-event";
import { UserAccountId } from "./test/user-account-id";

const JOURNAL_TABLE_NAME = "journal";
const SNAPSHOT_TABLE_NAME = "snapshot";

type FakeRow = Array<{
  name: string;
  value: unknown;
}>;

type FakeSqlRequest = {
  sql: string;
  params?: Record<string, unknown>;
};

type FakeJournalRow = {
  shardId: number;
  aggregateId: string;
  sequenceNumber: number;
  payload: Uint8Array;
};

type FakeSnapshotRow = {
  shardId: number;
  aggregateId: string;
  sequenceNumber: number;
  version: number;
  payload: Uint8Array;
};

type FakeSpannerDatabaseOptions = {
  alreadyExistsAsPlainObject?: boolean;
  failJournalInsertWith?: unknown;
  failRetainedSnapshotInsert?: boolean;
  failRetainedSnapshotSelectWith?: unknown;
  failRunTransactionWith?: unknown;
  forceLatestSnapshotUpdateMiss?: boolean;
  missingSnapshotPayloadField?: boolean;
  retainedSequenceNumberFormat?: "number" | "string" | "wrapped" | "invalid";
  snapshotPayloadFormat?: "bytes" | "base64" | "invalid" | "invalid-base64";
  snapshotVersionFormat?:
    | "number"
    | "string"
    | "wrapped"
    | "wrapped-number"
    | "wrapped-unsafe"
    | "wrapped-invalid"
    | "invalid"
    | "nan"
    | "unsafe";
};

function createFakeSpannerDatabase(options: FakeSpannerDatabaseOptions = {}) {
  const journalRows = new Map<string, FakeJournalRow>();
  const snapshotRows = new Map<string, FakeSnapshotRow>();

  function asDatabase(): Database {
    return fakeDatabase as unknown as Database;
  }

  function setFailRetainedSnapshotSelectWith(error: unknown): void {
    options.failRetainedSnapshotSelectWith = error;
  }

  function getRetainedSnapshotSequenceNumbers(aggregateId: string): number[] {
    return Array.from(snapshotRows.values())
      .filter(
        (row) => row.aggregateId === aggregateId && row.sequenceNumber > 0,
      )
      .map((row) => row.sequenceNumber)
      .sort((a, b) => a - b);
  }

  async function run(request: FakeSqlRequest): Promise<[FakeRow[]]> {
    if (request.sql.includes("FROM `journal`")) {
      return [selectJournalRows(requireParams(request))];
    }
    if (
      request.sql.includes("FROM `snapshot`") &&
      request.sql.includes("sequence_number = @sequenceNumber")
    ) {
      return [selectLatestSnapshotRows(requireParams(request))];
    }
    if (
      request.sql.includes("FROM `snapshot`") &&
      request.sql.includes("sequence_number > @latestSequenceNumber")
    ) {
      return [selectRetainedSnapshotRows(requireParams(request))];
    }
    throw new Error(`Unsupported SQL: ${request.sql}`);
  }

  async function runTransactionAsync<T>(
    runFn: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    if (options.failRunTransactionWith !== undefined) {
      throw options.failRunTransactionWith;
    }
    return runFn(
      createFakeSpannerTransaction(fakeDatabase) as unknown as Transaction,
    );
  }

  async function runUpdate(request: FakeSqlRequest): Promise<[number]> {
    if (request.sql.includes("INSERT INTO `journal`")) {
      if (options.failJournalInsertWith !== undefined) {
        throw options.failJournalInsertWith;
      }
      insertJournal(requireParams(request));
      return [1];
    }
    if (request.sql.includes("INSERT INTO `snapshot`")) {
      insertSnapshot(requireParams(request));
      return [1];
    }
    if (request.sql.includes("UPDATE `snapshot`")) {
      return [updateLatestSnapshot(requireParams(request))];
    }
    if (request.sql.includes("DELETE FROM `snapshot`")) {
      return [deleteSnapshot(requireParams(request))];
    }
    throw new Error(`Unsupported SQL: ${request.sql}`);
  }

  function selectJournalRows(params: Record<string, unknown>): FakeRow[] {
    const shardId = numberParam(params, "shardId");
    const aggregateId = stringParam(params, "aggregateId");
    const sequenceNumber = numberParam(params, "sequenceNumber");
    return Array.from(journalRows.values())
      .filter(
        (row) =>
          row.shardId === shardId &&
          row.aggregateId === aggregateId &&
          row.sequenceNumber >= sequenceNumber,
      )
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((row) => [{ name: "payload", value: row.payload }]);
  }

  function selectLatestSnapshotRows(
    params: Record<string, unknown>,
  ): FakeRow[] {
    const key = createKey(
      numberParam(params, "shardId"),
      stringParam(params, "aggregateId"),
      numberParam(params, "sequenceNumber"),
    );
    const row = snapshotRows.get(key);
    if (row === undefined) {
      return [];
    }
    return [
      [
        { name: "version", value: formatVersion(row.version) },
        ...(options.missingSnapshotPayloadField
          ? []
          : [
              {
                name: "payload",
                value: formatSnapshotPayload(row.payload),
              },
            ]),
      ],
    ];
  }

  function selectRetainedSnapshotRows(
    params: Record<string, unknown>,
  ): FakeRow[] {
    if (options.failRetainedSnapshotSelectWith !== undefined) {
      throw options.failRetainedSnapshotSelectWith;
    }
    const shardId = numberParam(params, "shardId");
    const aggregateId = stringParam(params, "aggregateId");
    const latestSequenceNumber = numberParam(params, "latestSequenceNumber");
    return Array.from(snapshotRows.values())
      .filter(
        (row) =>
          row.shardId === shardId &&
          row.aggregateId === aggregateId &&
          row.sequenceNumber > latestSequenceNumber,
      )
      .sort((a, b) => b.sequenceNumber - a.sequenceNumber)
      .map((row) => [
        {
          name: "sequence_number",
          value: formatRetainedSequenceNumber(row.sequenceNumber),
        },
      ]);
  }

  function insertJournal(params: Record<string, unknown>): void {
    const row: FakeJournalRow = {
      shardId: numberParam(params, "shardId"),
      aggregateId: stringParam(params, "aggregateId"),
      sequenceNumber: numberParam(params, "sequenceNumber"),
      payload: bytesParam(params, "payload"),
    };
    const key = createKey(row.shardId, row.aggregateId, row.sequenceNumber);
    if (journalRows.has(key)) {
      throw alreadyExistsError();
    }
    journalRows.set(key, row);
  }

  function insertSnapshot(params: Record<string, unknown>): void {
    const row: FakeSnapshotRow = {
      shardId: numberParam(params, "shardId"),
      aggregateId: stringParam(params, "aggregateId"),
      sequenceNumber: numberParam(params, "sequenceNumber"),
      version: numberParam(params, "version"),
      payload: bytesParam(params, "payload"),
    };
    const key = createKey(row.shardId, row.aggregateId, row.sequenceNumber);
    if (options.failRetainedSnapshotInsert === true && row.sequenceNumber > 0) {
      throw new Error("retained snapshot insert is disabled");
    }
    if (snapshotRows.has(key)) {
      throw alreadyExistsError();
    }
    snapshotRows.set(key, row);
  }

  function updateLatestSnapshot(params: Record<string, unknown>): number {
    const key = createKey(
      numberParam(params, "shardId"),
      stringParam(params, "aggregateId"),
      numberParam(params, "sequenceNumber"),
    );
    const row = snapshotRows.get(key);
    if (
      row === undefined ||
      options.forceLatestSnapshotUpdateMiss === true ||
      row.version !== numberParam(params, "beforeVersion")
    ) {
      return 0;
    }
    snapshotRows.set(key, {
      ...row,
      version: numberParam(params, "afterVersion"),
      payload:
        params.payload === undefined
          ? row.payload
          : bytesParam(params, "payload"),
    });
    return 1;
  }

  function deleteSnapshot(params: Record<string, unknown>): number {
    const key = createKey(
      numberParam(params, "shardId"),
      stringParam(params, "aggregateId"),
      numberParam(params, "sequenceNumber"),
    );
    return snapshotRows.delete(key) ? 1 : 0;
  }

  function requireParams(request: FakeSqlRequest): Record<string, unknown> {
    if (request.params === undefined) {
      throw new Error("params is undefined");
    }
    return request.params;
  }

  function numberParam(
    params: Record<string, unknown>,
    fieldName: string,
  ): number {
    const value = params[fieldName];
    if (typeof value !== "number") {
      throw new Error(`${fieldName} is not a number`);
    }
    return value;
  }

  function stringParam(
    params: Record<string, unknown>,
    fieldName: string,
  ): string {
    const value = params[fieldName];
    if (typeof value !== "string") {
      throw new Error(`${fieldName} is not a string`);
    }
    return value;
  }

  function bytesParam(
    params: Record<string, unknown>,
    fieldName: string,
  ): Uint8Array {
    const value = params[fieldName];
    if (!(value instanceof Uint8Array)) {
      throw new Error(`${fieldName} is not bytes`);
    }
    return value;
  }

  function createKey(
    shardId: number,
    aggregateId: string,
    sequenceNumber: number,
  ): string {
    return `${shardId}:${aggregateId}:${sequenceNumber}`;
  }

  function alreadyExistsError(): Error {
    if (options.alreadyExistsAsPlainObject === true) {
      return { code: 6, message: "Already exists" } as unknown as Error;
    }
    const error = new Error("Already exists") as Error & { code: number };
    error.code = 6;
    return error;
  }

  function formatRetainedSequenceNumber(sequenceNumber: number): unknown {
    switch (options.retainedSequenceNumberFormat) {
      case "string":
        return sequenceNumber.toString();
      case "wrapped":
        return { value: sequenceNumber.toString() };
      case "invalid":
        return "not-a-number";
      default:
        return sequenceNumber;
    }
  }

  function formatSnapshotPayload(payload: Uint8Array): unknown {
    switch (options.snapshotPayloadFormat) {
      case "base64":
        return Buffer.from(payload).toString("base64");
      case "invalid-base64":
        return "not-base64!";
      case "invalid":
        return { payload };
      default:
        return payload;
    }
  }

  function formatVersion(version: number): unknown {
    switch (options.snapshotVersionFormat) {
      case "string":
        return version.toString();
      case "wrapped":
        return { value: version.toString() };
      case "wrapped-number":
        return { value: version };
      case "wrapped-unsafe":
        return { value: Number.MAX_SAFE_INTEGER + 1 };
      case "wrapped-invalid":
        return { value: { version } };
      case "invalid":
        return { version };
      case "nan":
        return "not-a-number";
      case "unsafe":
        return Number.MAX_SAFE_INTEGER + 1;
      default:
        return version;
    }
  }
  const fakeDatabase = {
    asDatabase,
    run,
    runTransactionAsync,
    runUpdate,
    getRetainedSnapshotSequenceNumbers,
    setFailRetainedSnapshotSelectWith,
  };
  return Object.freeze(fakeDatabase);
}

function createFakeSpannerTransaction(
  database: ReturnType<typeof createFakeSpannerDatabase>,
) {
  async function run(request: FakeSqlRequest): Promise<[FakeRow[]]> {
    return database.run(request);
  }

  async function runUpdate(request: FakeSqlRequest): Promise<[number]> {
    return database.runUpdate(request);
  }

  async function commit(): Promise<void> {}

  async function rollback(): Promise<void> {}

  return Object.freeze({
    run,
    runUpdate,
    commit,
    rollback,
  });
}

type FakeEventStoreOptions = {
  eventSerializer?: EventSerializer<UserAccountId, UserAccountEvent>;
  logger?: Logger;
  shardSelector?: ShardSelector<UserAccountId>;
  snapshotSerializer?: SnapshotSerializer<UserAccountId, UserAccount>;
};

function createFakeEventStore(
  keepSnapshotCount?: number,
  database = createFakeSpannerDatabase(),
  options: FakeEventStoreOptions = {},
): EventStoreType<UserAccountId, UserAccount, UserAccountEvent> {
  return createSpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>({
    database: database.asDatabase(),
    journalTableName: JOURNAL_TABLE_NAME,
    snapshotTableName: SNAPSHOT_TABLE_NAME,
    shardCount: 32,
    eventConverter: convertJSONtoUserAccountEvent,
    snapshotConverter: convertJSONToUserAccount,
    keepSnapshotCount,
    ...options,
  });
}

describe("SpannerEventStore configuration", () => {
  const database = {} as Database;

  test.each([
    ["eventConverter", undefined],
    ["snapshotConverter", undefined],
  ])("rejects invalid %s", (converterName, converter) => {
    const input = {
      database,
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
      shardCount: 32,
      eventConverter: convertJSONtoUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
      [converterName]: converter,
    };

    expect(() => {
      createSpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>(
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
      createSpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>({
        database,
        journalTableName: JOURNAL_TABLE_NAME,
        snapshotTableName: SNAPSHOT_TABLE_NAME,
        shardCount,
        eventConverter: convertJSONtoUserAccountEvent,
        snapshotConverter: convertJSONToUserAccount,
      });
    }).toThrow("Invalid shardCount configuration");
  });

  test("rejects invalid Spanner table names", () => {
    expect(() => {
      createSpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>({
        database,
        journalTableName: "journal;drop",
        snapshotTableName: SNAPSHOT_TABLE_NAME,
        shardCount: 32,
        eventConverter: convertJSONtoUserAccountEvent,
        snapshotConverter: convertJSONToUserAccount,
      });
    }).toThrow("Invalid journalTableName configuration");
  });
});

describe("ShardId", () => {
  test("validates ShardId values", () => {
    expect(ShardId.create(0)).toBe(0);
    expect(ShardId.create(31)).toBe(31);
    expect(() => ShardId.create(-1)).toThrow("shardId must be");
    expect(() => ShardId.create(1.5)).toThrow("shardId must be");
    expect(() => ShardId.create(Number.POSITIVE_INFINITY)).toThrow(
      "shardId must be",
    );
  });
});

describe("SpannerEventStore", () => {
  runEventStoreContractTests({
    name: "SpannerEventStore contract",
    timeout: 1000,
    createEventStore: () => createFakeEventStore(),
  });

  test("creates SpannerEventStore through EventStore", async () => {
    const database = createFakeSpannerDatabase().asDatabase();
    const eventStore = EventStore.createSpanner<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      database,
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
      shardCount: 32,
      eventConverter: convertJSONtoUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
    });

    await expect(
      eventStore.getLatestSnapshotById(UserAccountId.create(ulid())),
    ).resolves.toBeUndefined();
  });

  test("hard-deletes retained snapshots older than keepSnapshotCount", async () => {
    const eventStore = createFakeEventStore(1);
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const [userAccount2, renamedToBob] = userAccount1.rename("Bob");
    await expectOk(
      eventStore.persistEventAndSnapshot(renamedToBob, userAccount2),
    );

    const snapshotAfterBob = await eventStore.getLatestSnapshotById(id);
    if (snapshotAfterBob === undefined) {
      throw new Error("snapshotAfterBob is undefined");
    }
    const [userAccount3, renamedToCarol] = snapshotAfterBob.rename("Carol");
    await expectOk(
      eventStore.persistEventAndSnapshot(renamedToCarol, userAccount3),
    );

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);

    expect(latestSnapshot?.name).toBe("Carol");
  });

  test("skips retained snapshot writes when keepSnapshotCount is zero", async () => {
    const eventStore = createFakeEventStore(
      0,
      createFakeSpannerDatabase({ failRetainedSnapshotInsert: true }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const [userAccount2, renamed] = userAccount1.rename("Bob");
    await expectOk(eventStore.persistEventAndSnapshot(renamed, userAccount2));

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);
    expect(latestSnapshot?.name).toBe("Bob");
  });

  test("purges existing retained snapshots when keepSnapshotCount is zero", async () => {
    const database = createFakeSpannerDatabase();
    const retainedEventStore = createFakeEventStore(2, database);
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(
      retainedEventStore.persistEventAndSnapshot(created, userAccount1),
    );

    const [userAccount2, renamedToBob] = userAccount1.rename("Bob");
    await expectOk(
      retainedEventStore.persistEventAndSnapshot(renamedToBob, userAccount2),
    );
    expect(database.getRetainedSnapshotSequenceNumbers(id.asString())).toEqual([
      1, 2,
    ]);

    const zeroRetentionEventStore = createFakeEventStore(0, database);
    const snapshotAfterBob =
      await zeroRetentionEventStore.getLatestSnapshotById(id);
    if (snapshotAfterBob === undefined) {
      throw new Error("snapshotAfterBob is undefined");
    }
    const [userAccount3, renamedToCarol] = snapshotAfterBob.rename("Carol");
    await expectOk(
      zeroRetentionEventStore.persistEventAndSnapshot(
        renamedToCarol,
        userAccount3,
      ),
    );

    expect(database.getRetainedSnapshotSequenceNumbers(id.asString())).toEqual(
      [],
    );
  });

  test("converts duplicate journal inserts to optimistic lock conflict", async () => {
    const eventStore = createFakeEventStore();
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const [userAccount2, renamed] = userAccount1.rename("Bob");
    await expectOk(eventStore.persistEvent(renamed, userAccount2.version));

    await expectOptimisticLockConflict(
      eventStore.persistEvent(renamed, userAccount2.version + 1),
    );
  });

  test("converts plain ALREADY_EXISTS failures to optimistic lock conflict", async () => {
    const database = createFakeSpannerDatabase({
      alreadyExistsAsPlainObject: true,
    });
    const eventStore = createFakeEventStore(undefined, database);
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const [userAccount2, renamed] = userAccount1.rename("Bob");
    await expectOk(eventStore.persistEvent(renamed, userAccount2.version));

    await expectOptimisticLockConflict(
      eventStore.persistEvent(renamed, userAccount2.version + 1),
    );
  });

  test("propagates non optimistic-lock Spanner failures unchanged", async () => {
    const error = new Error("unavailable") as Error & { code: number };
    error.code = 14;
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase({
        failRunTransactionWith: error,
      }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expectStorageError(
      eventStore.persistEventAndSnapshot(created, userAccount1),
      error,
    );
  });

  test.each([
    ["null", null],
    ["string", "unavailable"],
    ["object without code", { message: "unavailable" }],
    ["object with string code", { code: "6", message: "unavailable" }],
    ["non matching code", { code: 14, message: "unavailable" }],
  ])("propagates %s Spanner failures unchanged", async (_, error) => {
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase({
        failRunTransactionWith: error,
      }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expectStorageError(
      eventStore.persistEventAndSnapshot(created, userAccount1),
      error,
    );
  });

  test("converts direct journal insert failures to storage errors", async () => {
    const error = new Error("journal insert failed");
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase({
        failJournalInsertWith: error,
      }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expectStorageError(
      eventStore.persistEventAndSnapshot(created, userAccount1),
      error,
    );
  });

  test("converts event serializer failures to serialization errors", async () => {
    const error = new Error("event serialization failed");
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase(),
      {
        eventSerializer: {
          serialize: jest.fn(() => {
            throw error;
          }),
          deserialize: jest.fn(),
        },
      },
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expectSerializationError(
      eventStore.persistEventAndSnapshot(created, userAccount1),
      error,
    );
  });

  test("converts snapshot serializer failures to serialization errors", async () => {
    const error = new Error("snapshot serialization failed");
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase(),
      {
        snapshotSerializer: {
          serialize: jest.fn(() => {
            throw error;
          }),
          deserialize: jest.fn(),
        },
      },
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expectSerializationError(
      eventStore.persistEventAndSnapshot(created, userAccount1),
      error,
    );
  });

  test("converts transaction ALREADY_EXISTS failures to optimistic locks", async () => {
    const error = new Error("Already exists") as Error & { code: number };
    error.code = 6;
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase({
        failRunTransactionWith: error,
      }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expectOptimisticLockConflict(
      eventStore.persistEventAndSnapshot(created, userAccount1),
    );
  });

  test("uses custom shard selector, serializers, and logger", async () => {
    const jsonEventSerializer = createJsonEventSerializer();
    const jsonSnapshotSerializer = createJsonSnapshotSerializer();
    const eventSerializer: EventSerializer<UserAccountId, UserAccountEvent> = {
      serialize: jest.fn((event) => jsonEventSerializer.serialize(event)),
      deserialize: jest.fn((bytes, converter) =>
        jsonEventSerializer.deserialize(bytes, converter),
      ),
    };
    const snapshotSerializer: SnapshotSerializer<UserAccountId, UserAccount> = {
      serialize: jest.fn((aggregate) =>
        jsonSnapshotSerializer.serialize(aggregate),
      ),
      deserialize: jest.fn((bytes, converter) =>
        jsonSnapshotSerializer.deserialize(bytes, converter),
      ),
    };
    const logger: Logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const shardSelector: ShardSelector<UserAccountId> = {
      selectShardId: jest.fn(() => ShardId.create(0)),
    };
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase(),
      {
        eventSerializer,
        logger,
        shardSelector,
        snapshotSerializer,
      },
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const [userAccount2, renamed] = userAccount1.rename("Bob");
    await expectOk(eventStore.persistEventAndSnapshot(renamed, userAccount2));
    const snapshotAfterBob = await eventStore.getLatestSnapshotById(id);
    if (snapshotAfterBob === undefined) {
      throw new Error("snapshotAfterBob is undefined");
    }
    const [, renamedToCarol] = snapshotAfterBob.rename("Carol");
    await expectOk(
      eventStore.persistEvent(renamedToCarol, snapshotAfterBob.version),
    );
    const events = await eventStore.getEventsByIdSinceSequenceNumber(id, 1);
    const latestSnapshot = await eventStore.getLatestSnapshotById(id);

    expect(events).toHaveLength(3);
    expect(latestSnapshot?.name).toBe("Bob");
    expect(shardSelector.selectShardId).toHaveBeenCalledWith(id, 32);
    expect(eventSerializer.serialize).toHaveBeenCalled();
    expect(eventSerializer.deserialize).toHaveBeenCalled();
    expect(snapshotSerializer.serialize).toHaveBeenCalled();
    expect(snapshotSerializer.deserialize).toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  test("rejects failed conditional latest snapshot updates as optimistic locks", async () => {
    const database = createFakeSpannerDatabase({
      forceLatestSnapshotUpdateMiss: true,
    });
    const eventStore = createFakeEventStore(undefined, database);
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const [userAccount2, renamed] = userAccount1.rename("Bob");

    await expectOptimisticLockConflict(
      eventStore.persistEvent(renamed, userAccount2.version),
    );
  });

  test.each([
    ["string", "string"],
    ["wrapped", "wrapped"],
  ] as const)("purges retained snapshots when sequence numbers are returned as %s", async (_, retainedSequenceNumberFormat) => {
    const eventStore = createFakeEventStore(
      1,
      createFakeSpannerDatabase({ retainedSequenceNumberFormat }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const [userAccount2, renamed] = userAccount1.rename("Bob");
    await expectOk(eventStore.persistEventAndSnapshot(renamed, userAccount2));

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);
    expect(latestSnapshot?.name).toBe("Bob");
  });

  test.each([
    ["base64 payload", { snapshotPayloadFormat: "base64" }],
    ["string version", { snapshotVersionFormat: "string" }],
    ["wrapped version", { snapshotVersionFormat: "wrapped" }],
    ["wrapped numeric version", { snapshotVersionFormat: "wrapped-number" }],
  ] as const)("reads snapshots with Spanner row %s", async (_, options) => {
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase(options),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);

    expect(latestSnapshot?.name).toBe("Alice");
  });

  test.each([
    [
      "invalid snapshot version",
      { snapshotVersionFormat: "invalid" },
      "version is not a number",
    ],
    [
      "invalid wrapped snapshot version",
      { snapshotVersionFormat: "wrapped-invalid" },
      "version is not a number",
    ],
    [
      "NaN snapshot version",
      { snapshotVersionFormat: "nan" },
      "version is not a safe integer",
    ],
    [
      "unsafe numeric snapshot version",
      { snapshotVersionFormat: "unsafe" },
      "version is not a safe integer",
    ],
    [
      "unsafe wrapped numeric snapshot version",
      { snapshotVersionFormat: "wrapped-unsafe" },
      "version is not a safe integer",
    ],
    [
      "invalid snapshot payload",
      { snapshotPayloadFormat: "invalid" },
      "payload is not bytes",
    ],
    [
      "invalid base64 snapshot payload",
      { snapshotPayloadFormat: "invalid-base64" },
      "payload is not valid base64",
    ],
    [
      "missing snapshot payload",
      { missingSnapshotPayloadField: true },
      "payload is undefined",
    ],
  ] as const)("rejects malformed Spanner rows with %s", async (_, options, message) => {
    const eventStore = createFakeEventStore(
      undefined,
      createFakeSpannerDatabase(options),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

    await expect(eventStore.getLatestSnapshotById(id)).rejects.toThrow(message);
  });

  test("rejects invalid keepSnapshotCount at construction", () => {
    expect(() => createFakeEventStore(Number.NaN)).toThrow(
      "keepSnapshotCount must be finite",
    );
  });

  test("rejects invalid retained snapshot sequence numbers during retention", async () => {
    const eventStore = createFakeEventStore(
      1,
      createFakeSpannerDatabase({ retainedSequenceNumberFormat: "invalid" }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expectStorageError(
      eventStore.persistEventAndSnapshot(created, userAccount1),
      expect.any(Error),
    );
  });

  test("returns event store errors raised during snapshot retention", async () => {
    const error = EventStoreError.storage("retention failed");
    const eventStore = createFakeEventStore(
      1,
      createFakeSpannerDatabase({
        failRetainedSnapshotSelectWith: error,
      }),
    );
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    const result = await eventStore.persistEventAndSnapshot(
      created,
      userAccount1,
    );

    expect(result).toEqual({ type: "err", error });
  });

  test("returns snapshot retention errors after event-only writes", async () => {
    const error = EventStoreError.storage("retention failed");
    const database = createFakeSpannerDatabase();
    const eventStore = createFakeEventStore(1, database);
    const id = UserAccountId.create(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));
    const [userAccount2, renamed] = userAccount1.rename("Bob");

    database.setFailRetainedSnapshotSelectWith(error);

    const result = await eventStore.persistEvent(renamed, userAccount2.version);

    expect(result).toEqual({ type: "err", error });
  });
});

const describeSpannerIntegration =
  process.env.RUN_SPANNER_EMULATOR_TESTS === "1" ? describe : describe.skip;

describeSpannerIntegration("SpannerEventStore emulator", () => {
  const parsedTestTimeFactor = Number.parseFloat(
    process.env.TEST_TIME_FACTOR ?? "1.0",
  );
  const TEST_TIME_FACTOR = Number.isFinite(parsedTestTimeFactor)
    ? parsedTestTimeFactor
    : 1.0;
  const TIMEOUT: number = 120 * 1000 * TEST_TIME_FACTOR;

  let container: TestContainer;
  let startedContainer: StartedTestContainer;
  let spanner: Spanner;
  let database: Database;
  let restoreEmulatorHost: () => void;

  function createEventStore(
    keepSnapshotCount?: number,
  ): EventStoreType<UserAccountId, UserAccount, UserAccountEvent> {
    return createSpannerEventStore<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      database,
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
      shardCount: 32,
      eventConverter: convertJSONtoUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
      keepSnapshotCount,
    });
  }

  beforeAll(async () => {
    container = new GenericContainer("gcr.io/cloud-spanner-emulator/emulator")
      .withExposedPorts(9010)
      .withWaitStrategy(Wait.forListeningPorts());
    startedContainer = await container.start();
    const context = await createSpannerDatabase({
      startedContainer,
      instanceId: "test-instance",
      databaseId: "test-database",
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
    });
    spanner = context.spanner;
    database = context.database;
    restoreEmulatorHost = context.restoreEmulatorHost;
  }, TIMEOUT);

  afterAll(async () => {
    if (database !== undefined) {
      await database.close();
    }
    if (spanner !== undefined) {
      spanner.close();
    }
    if (restoreEmulatorHost !== undefined) {
      restoreEmulatorHost();
    }
    if (startedContainer !== undefined) {
      await startedContainer.stop();
    }
  }, TIMEOUT);

  runEventStoreContractTests({
    name: "SpannerEventStore contract",
    timeout: TIMEOUT,
    createEventStore: () => createEventStore(),
  });

  test(
    "hard-deletes retained snapshots older than keepSnapshotCount",
    async () => {
      const eventStore = createEventStore(1);
      const id = UserAccountId.create(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");
      await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

      const [userAccount2, renamedToBob] = userAccount1.rename("Bob");
      await expectOk(
        eventStore.persistEventAndSnapshot(renamedToBob, userAccount2),
      );

      const snapshotAfterBob = await eventStore.getLatestSnapshotById(id);
      if (snapshotAfterBob === undefined) {
        throw new Error("snapshotAfterBob is undefined");
      }
      const [userAccount3, renamedToCarol] = snapshotAfterBob.rename("Carol");
      await expectOk(
        eventStore.persistEventAndSnapshot(renamedToCarol, userAccount3),
      );

      const [rows] = await database.run({
        sql: `
          SELECT sequence_number
          FROM ${SNAPSHOT_TABLE_NAME}
          WHERE aggregate_id = @aggregateId
            AND sequence_number > 0
          ORDER BY sequence_number ASC
        `,
        params: {
          aggregateId: id.asString(),
        },
      });

      expect(
        (
          rows as Array<
            Array<{
              name: string;
              value: unknown;
            }>
          >
        ).map((row) => row[0].value),
      ).toEqual([3]);
    },
    TIMEOUT,
  );

  test(
    "converts duplicate journal inserts to optimistic lock conflict",
    async () => {
      const eventStore = createEventStore();
      const id = UserAccountId.create(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");
      await expectOk(eventStore.persistEventAndSnapshot(created, userAccount1));

      const [userAccount2, renamed] = userAccount1.rename("Bob");
      await expectOk(eventStore.persistEvent(renamed, userAccount2.version));

      await expectOptimisticLockConflict(
        eventStore.persistEvent(renamed, userAccount2.version + 1),
      );
    },
    TIMEOUT,
  );
});

async function expectOk(
  resultPromise: Promise<Result<void, EventStoreError>>,
): Promise<void> {
  const result = await resultPromise;
  expect(result).toEqual({ type: "ok", value: undefined });
}

async function expectOptimisticLockConflict(
  resultPromise: Promise<Result<void, EventStoreError>>,
): Promise<void> {
  const result = await resultPromise;
  expect(result.type).toBe("err");
  if (result.type !== "err") {
    return;
  }
  expect(result.error.type).toBe("optimistic-lock-conflict");
}

async function expectStorageError(
  resultPromise: Promise<Result<void, EventStoreError>>,
  cause: unknown,
): Promise<void> {
  const result = await resultPromise;
  expect(result.type).toBe("err");
  if (result.type !== "err") {
    return;
  }
  expect(result.error.type).toBe("storage-error");
  expect(result.error.cause).toEqual(cause);
}

async function expectSerializationError(
  resultPromise: Promise<Result<void, EventStoreError>>,
  cause: unknown,
): Promise<void> {
  const result = await resultPromise;
  expect(result.type).toBe("err");
  if (result.type !== "err") {
    return;
  }
  expect(result.error.type).toBe("serialization-error");
  expect(result.error.cause).toEqual(cause);
}
