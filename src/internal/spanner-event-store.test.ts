import type { Database, Spanner } from "@google-cloud/spanner";
import {
  GenericContainer,
  type StartedTestContainer,
  type TestContainer,
  Wait,
} from "testcontainers";
import { ulid } from "ulid";
import { EventStoreFactory } from "../event-store";
import { createShardId } from "../shard-id";
import { OptimisticLockError } from "../types";
import { DefaultKeyResolver } from "./default-key-resolver";
import { DefaultSpannerShardSelector } from "./default-spanner-shard-selector";
import { SpannerEventStore } from "./spanner-event-store";
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
  failRunTransactionWith?: unknown;
  forceLatestSnapshotUpdateMiss?: boolean;
  missingSnapshotPayloadField?: boolean;
  retainedSequenceNumberFormat?: "number" | "string" | "wrapped";
  snapshotPayloadFormat?: "bytes" | "base64" | "invalid";
  snapshotVersionFormat?: "number" | "string" | "wrapped" | "invalid";
};

class FakeSpannerDatabase {
  private readonly journalRows = new Map<string, FakeJournalRow>();
  private readonly snapshotRows = new Map<string, FakeSnapshotRow>();

  constructor(private readonly options: FakeSpannerDatabaseOptions = {}) {}

  asDatabase(): Database {
    return this as unknown as Database;
  }

  async run(request: FakeSqlRequest): Promise<[FakeRow[]]> {
    if (request.sql.includes("FROM `journal`")) {
      return [this.selectJournalRows(this.requireParams(request))];
    }
    if (
      request.sql.includes("FROM `snapshot`") &&
      request.sql.includes("sequence_number = @sequenceNumber")
    ) {
      return [this.selectLatestSnapshotRows(this.requireParams(request))];
    }
    if (
      request.sql.includes("FROM `snapshot`") &&
      request.sql.includes("sequence_number > @latestSequenceNumber")
    ) {
      return [this.selectRetainedSnapshotRows(this.requireParams(request))];
    }
    throw new Error(`Unsupported SQL: ${request.sql}`);
  }

  async runTransactionAsync<T>(
    runFn: (transaction: FakeSpannerTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.options.failRunTransactionWith !== undefined) {
      throw this.options.failRunTransactionWith;
    }
    return runFn(new FakeSpannerTransaction(this));
  }

  async runUpdate(request: FakeSqlRequest): Promise<[number]> {
    if (request.sql.includes("INSERT INTO `journal`")) {
      this.insertJournal(this.requireParams(request));
      return [1];
    }
    if (request.sql.includes("INSERT INTO `snapshot`")) {
      this.insertSnapshot(this.requireParams(request));
      return [1];
    }
    if (request.sql.includes("UPDATE `snapshot`")) {
      return [this.updateLatestSnapshot(this.requireParams(request))];
    }
    if (request.sql.includes("DELETE FROM `snapshot`")) {
      return [this.deleteSnapshot(this.requireParams(request))];
    }
    throw new Error(`Unsupported SQL: ${request.sql}`);
  }

  private selectJournalRows(params: Record<string, unknown>): FakeRow[] {
    const shardId = this.numberParam(params, "shardId");
    const aggregateId = this.stringParam(params, "aggregateId");
    const sequenceNumber = this.numberParam(params, "sequenceNumber");
    return Array.from(this.journalRows.values())
      .filter(
        (row) =>
          row.shardId === shardId &&
          row.aggregateId === aggregateId &&
          row.sequenceNumber >= sequenceNumber,
      )
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((row) => [{ name: "payload", value: row.payload }]);
  }

  private selectLatestSnapshotRows(params: Record<string, unknown>): FakeRow[] {
    const key = this.createKey(
      this.numberParam(params, "shardId"),
      this.stringParam(params, "aggregateId"),
      this.numberParam(params, "sequenceNumber"),
    );
    const row = this.snapshotRows.get(key);
    if (row === undefined) {
      return [];
    }
    return [
      [
        { name: "version", value: this.formatVersion(row.version) },
        ...(this.options.missingSnapshotPayloadField
          ? []
          : [
              {
                name: "payload",
                value: this.formatSnapshotPayload(row.payload),
              },
            ]),
      ],
    ];
  }

  private selectRetainedSnapshotRows(
    params: Record<string, unknown>,
  ): FakeRow[] {
    const shardId = this.numberParam(params, "shardId");
    const aggregateId = this.stringParam(params, "aggregateId");
    const latestSequenceNumber = this.numberParam(
      params,
      "latestSequenceNumber",
    );
    return Array.from(this.snapshotRows.values())
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
          value: this.formatRetainedSequenceNumber(row.sequenceNumber),
        },
      ]);
  }

  private insertJournal(params: Record<string, unknown>): void {
    const row: FakeJournalRow = {
      shardId: this.numberParam(params, "shardId"),
      aggregateId: this.stringParam(params, "aggregateId"),
      sequenceNumber: this.numberParam(params, "sequenceNumber"),
      payload: this.bytesParam(params, "payload"),
    };
    const key = this.createKey(
      row.shardId,
      row.aggregateId,
      row.sequenceNumber,
    );
    if (this.journalRows.has(key)) {
      throw this.alreadyExistsError();
    }
    this.journalRows.set(key, row);
  }

  private insertSnapshot(params: Record<string, unknown>): void {
    const row: FakeSnapshotRow = {
      shardId: this.numberParam(params, "shardId"),
      aggregateId: this.stringParam(params, "aggregateId"),
      sequenceNumber: this.numberParam(params, "sequenceNumber"),
      version: this.numberParam(params, "version"),
      payload: this.bytesParam(params, "payload"),
    };
    const key = this.createKey(
      row.shardId,
      row.aggregateId,
      row.sequenceNumber,
    );
    if (this.snapshotRows.has(key)) {
      throw this.alreadyExistsError();
    }
    this.snapshotRows.set(key, row);
  }

  private updateLatestSnapshot(params: Record<string, unknown>): number {
    const key = this.createKey(
      this.numberParam(params, "shardId"),
      this.stringParam(params, "aggregateId"),
      this.numberParam(params, "sequenceNumber"),
    );
    const row = this.snapshotRows.get(key);
    if (
      row === undefined ||
      this.options.forceLatestSnapshotUpdateMiss === true ||
      row.version !== this.numberParam(params, "beforeVersion")
    ) {
      return 0;
    }
    this.snapshotRows.set(key, {
      ...row,
      version: this.numberParam(params, "afterVersion"),
      payload:
        params.payload === undefined
          ? row.payload
          : this.bytesParam(params, "payload"),
    });
    return 1;
  }

  private deleteSnapshot(params: Record<string, unknown>): number {
    const key = this.createKey(
      this.numberParam(params, "shardId"),
      this.stringParam(params, "aggregateId"),
      this.numberParam(params, "sequenceNumber"),
    );
    return this.snapshotRows.delete(key) ? 1 : 0;
  }

  private requireParams(request: FakeSqlRequest): Record<string, unknown> {
    if (request.params === undefined) {
      throw new Error("params is undefined");
    }
    return request.params;
  }

  private numberParam(
    params: Record<string, unknown>,
    fieldName: string,
  ): number {
    const value = params[fieldName];
    if (typeof value !== "number") {
      throw new Error(`${fieldName} is not a number`);
    }
    return value;
  }

  private stringParam(
    params: Record<string, unknown>,
    fieldName: string,
  ): string {
    const value = params[fieldName];
    if (typeof value !== "string") {
      throw new Error(`${fieldName} is not a string`);
    }
    return value;
  }

  private bytesParam(
    params: Record<string, unknown>,
    fieldName: string,
  ): Uint8Array {
    const value = params[fieldName];
    if (!(value instanceof Uint8Array)) {
      throw new Error(`${fieldName} is not bytes`);
    }
    return value;
  }

  private createKey(
    shardId: number,
    aggregateId: string,
    sequenceNumber: number,
  ): string {
    return `${shardId}:${aggregateId}:${sequenceNumber}`;
  }

  private alreadyExistsError(): Error {
    if (this.options.alreadyExistsAsPlainObject === true) {
      return { code: 6, message: "Already exists" } as unknown as Error;
    }
    const error = new Error("Already exists") as Error & { code: number };
    error.code = 6;
    return error;
  }

  private formatRetainedSequenceNumber(sequenceNumber: number): unknown {
    switch (this.options.retainedSequenceNumberFormat) {
      case "string":
        return sequenceNumber.toString();
      case "wrapped":
        return { value: sequenceNumber.toString() };
      default:
        return sequenceNumber;
    }
  }

  private formatSnapshotPayload(payload: Uint8Array): unknown {
    switch (this.options.snapshotPayloadFormat) {
      case "base64":
        return Buffer.from(payload).toString("base64");
      case "invalid":
        return { payload };
      default:
        return payload;
    }
  }

  private formatVersion(version: number): unknown {
    switch (this.options.snapshotVersionFormat) {
      case "string":
        return version.toString();
      case "wrapped":
        return { value: version.toString() };
      case "invalid":
        return { version };
      default:
        return version;
    }
  }
}

class FakeSpannerTransaction {
  constructor(private readonly database: FakeSpannerDatabase) {}

  async run(request: FakeSqlRequest): Promise<[FakeRow[]]> {
    return this.database.run(request);
  }

  async runUpdate(request: FakeSqlRequest): Promise<[number]> {
    return this.database.runUpdate(request);
  }

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}
}

function createFakeEventStore(
  keepSnapshotCount?: number,
  database = new FakeSpannerDatabase(),
): SpannerEventStore<UserAccountId, UserAccount, UserAccountEvent> {
  return new SpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>({
    database: database.asDatabase(),
    journalTableName: JOURNAL_TABLE_NAME,
    snapshotTableName: SNAPSHOT_TABLE_NAME,
    shardCount: 32,
    eventConverter: convertJSONtoUserAccountEvent,
    snapshotConverter: convertJSONToUserAccount,
    keepSnapshotCount,
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
      new SpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>(
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
      new SpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>({
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
      new SpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>({
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
    expect(createShardId(0)).toBe(0);
    expect(createShardId(31)).toBe(31);
    expect(() => createShardId(-1)).toThrow("shardId must be");
    expect(() => createShardId(1.5)).toThrow("shardId must be");
    expect(() => createShardId(Number.POSITIVE_INFINITY)).toThrow(
      "shardId must be",
    );
  });
});

describe("DefaultSpannerShardSelector", () => {
  test("selects the same shard as the existing hash distribution", () => {
    const id = new UserAccountId(ulid());
    const shardCount = 32;
    const selector = new DefaultSpannerShardSelector<UserAccountId>();
    const keyResolver = new DefaultKeyResolver<UserAccountId>();
    const dynamodbPartitionKey = keyResolver.resolvePartitionKey(
      id,
      shardCount,
    );
    const expectedShardId = Number(dynamodbPartitionKey.split("-").at(-1));

    expect(selector.selectShardId(id, shardCount)).toBe(
      createShardId(expectedShardId),
    );
  });

  test("rejects invalid inputs before selecting a shard", () => {
    const selector = new DefaultSpannerShardSelector<UserAccountId>();
    const id = new UserAccountId(ulid());
    const invalidId = {
      typeName: "user-account",
      value: id.value,
      asString: () => undefined,
    } as unknown as UserAccountId;

    expect(() =>
      selector.selectShardId(undefined as unknown as UserAccountId, 32),
    ).toThrow("aggregateId is undefined or null");
    expect(() => selector.selectShardId(id, 0)).toThrow(
      "shardCount must be a positive safe integer",
    );
    expect(() => selector.selectShardId(invalidId, 32)).toThrow(
      "str is undefined or null",
    );
  });
});

describe("SpannerEventStore", () => {
  runEventStoreContractTests({
    name: "SpannerEventStore contract",
    timeout: 1000,
    createEventStore: () => createFakeEventStore(),
  });

  test("creates SpannerEventStore through EventStoreFactory", async () => {
    const database = new FakeSpannerDatabase().asDatabase();
    const eventStore = EventStoreFactory.ofSpanner<
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
      eventStore.getLatestSnapshotById(new UserAccountId(ulid())),
    ).resolves.toBeUndefined();
  });

  test("hard-deletes retained snapshots older than keepSnapshotCount", async () => {
    const eventStore = createFakeEventStore(1);
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const [userAccount2, renamedToBob] = userAccount1.rename("Bob");
    await eventStore.persistEventAndSnapshot(renamedToBob, userAccount2);

    const [userAccount3, renamedToCarol] = userAccount2
      .withVersion(userAccount2.version + 1)
      .rename("Carol");
    await eventStore.persistEventAndSnapshot(renamedToCarol, userAccount3);

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);

    expect(latestSnapshot?.name).toBe("Carol");
  });

  test("converts duplicate journal inserts to OptimisticLockError", async () => {
    const eventStore = createFakeEventStore();
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const [userAccount2, renamed] = userAccount1.rename("Bob");
    await eventStore.persistEvent(renamed, userAccount2.version);

    await expect(
      eventStore.persistEvent(renamed, userAccount2.version + 1),
    ).rejects.toThrow(OptimisticLockError);
  });

  test("converts plain ALREADY_EXISTS failures to OptimisticLockError", async () => {
    const database = new FakeSpannerDatabase({
      alreadyExistsAsPlainObject: true,
    });
    const eventStore = createFakeEventStore(undefined, database);
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const [userAccount2, renamed] = userAccount1.rename("Bob");
    await eventStore.persistEvent(renamed, userAccount2.version);

    await expect(
      eventStore.persistEvent(renamed, userAccount2.version + 1),
    ).rejects.toThrow(OptimisticLockError);
  });

  test("propagates non optimistic-lock Spanner failures unchanged", async () => {
    const error = new Error("unavailable") as Error & { code: number };
    error.code = 14;
    const eventStore = createFakeEventStore(
      undefined,
      new FakeSpannerDatabase({
        failRunTransactionWith: error,
      }),
    );
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expect(
      eventStore.persistEventAndSnapshot(created, userAccount1),
    ).rejects.toBe(error);
  });

  test("rejects failed conditional latest snapshot updates as optimistic locks", async () => {
    const database = new FakeSpannerDatabase({
      forceLatestSnapshotUpdateMiss: true,
    });
    const eventStore = createFakeEventStore(undefined, database);
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const [userAccount2, renamed] = userAccount1.rename("Bob");

    await expect(
      eventStore.persistEvent(renamed, userAccount2.version),
    ).rejects.toThrow(OptimisticLockError);
  });

  test.each([
    ["string", "string"],
    ["wrapped", "wrapped"],
  ] as const)("purges retained snapshots when sequence numbers are returned as %s", async (_, retainedSequenceNumberFormat) => {
    const eventStore = createFakeEventStore(
      0,
      new FakeSpannerDatabase({ retainedSequenceNumberFormat }),
    );
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await eventStore.persistEventAndSnapshot(created, userAccount1);

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);
    expect(latestSnapshot?.name).toBe("Alice");
  });

  test.each([
    ["base64 payload", { snapshotPayloadFormat: "base64" }],
    ["string version", { snapshotVersionFormat: "string" }],
    ["wrapped version", { snapshotVersionFormat: "wrapped" }],
  ] as const)("reads snapshots with Spanner row %s", async (_, options) => {
    const eventStore = createFakeEventStore(
      undefined,
      new FakeSpannerDatabase(options),
    );
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await eventStore.persistEventAndSnapshot(created, userAccount1);

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
      "invalid snapshot payload",
      { snapshotPayloadFormat: "invalid" },
      "payload is not bytes",
    ],
    [
      "missing snapshot payload",
      { missingSnapshotPayloadField: true },
      "payload is undefined",
    ],
  ] as const)("rejects malformed Spanner rows with %s", async (_, options, message) => {
    const eventStore = createFakeEventStore(
      undefined,
      new FakeSpannerDatabase(options),
    );
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    await eventStore.persistEventAndSnapshot(created, userAccount1);

    await expect(eventStore.getLatestSnapshotById(id)).rejects.toThrow(message);
  });

  test("propagates invalid keepSnapshotCount during retention", async () => {
    const eventStore = createFakeEventStore(Number.NaN);
    const id = new UserAccountId(ulid());
    const [userAccount1, created] = UserAccount.create(id, "Alice");

    await expect(
      eventStore.persistEventAndSnapshot(created, userAccount1),
    ).rejects.toThrow("keepSnapshotCount must be finite");
  });
});

const describeSpannerIntegration =
  process.env.RUN_SPANNER_EMULATOR_TESTS === "1" ? describe : describe.skip;

describeSpannerIntegration("SpannerEventStore emulator", () => {
  const TEST_TIME_FACTOR = Number.parseFloat(
    process.env.TEST_TIME_FACTOR ?? "1.0",
  );
  const TIMEOUT: number = 120 * 1000 * TEST_TIME_FACTOR;

  let container: TestContainer;
  let startedContainer: StartedTestContainer;
  let spanner: Spanner;
  let database: Database;
  let restoreEmulatorHost: () => void;

  function createEventStore(
    keepSnapshotCount?: number,
  ): SpannerEventStore<UserAccountId, UserAccount, UserAccountEvent> {
    return new SpannerEventStore<UserAccountId, UserAccount, UserAccountEvent>({
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
      const id = new UserAccountId(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");
      await eventStore.persistEventAndSnapshot(created, userAccount1);

      const [userAccount2, renamedToBob] = userAccount1.rename("Bob");
      await eventStore.persistEventAndSnapshot(renamedToBob, userAccount2);

      const [userAccount3, renamedToCarol] = userAccount2
        .withVersion(userAccount2.version + 1)
        .rename("Carol");
      await eventStore.persistEventAndSnapshot(renamedToCarol, userAccount3);

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
    "converts duplicate journal inserts to OptimisticLockError",
    async () => {
      const eventStore = createEventStore();
      const id = new UserAccountId(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");
      await eventStore.persistEventAndSnapshot(created, userAccount1);

      const [userAccount2, renamed] = userAccount1.rename("Bob");
      await eventStore.persistEvent(renamed, userAccount2.version);

      await expect(
        eventStore.persistEvent(renamed, userAccount2.version + 1),
      ).rejects.toThrow(OptimisticLockError);
    },
    TIMEOUT,
  );
});
