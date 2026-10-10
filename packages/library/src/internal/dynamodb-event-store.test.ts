import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttributeValue,
  type BatchGetItemCommandInput,
  DeleteItemCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  TransactionCanceledException,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import { initializeDynamoDBEventStoreInternal } from "./dynamodb-event-store";
import { DynamoDBConfigurationResponsePlan } from "./test/dynamodb-configuration-response-plan";
import { DynamoDBLocal } from "./test/dynamodb-local";

const seed = {
  journal: {
    aid: { S: "__config__" },
    seq_nr: { N: "0" },
    store_id: { S: "seeded-store" },
    layout_version: { N: "1" },
  },
  snapshot: {
    aid: { S: "__config__" },
    skey: { N: "0" },
    store_id: { S: "seeded-store" },
    layout_version: { N: "1" },
  },
  head: {
    aid: { S: "__config__" },
    store_id: { S: "seeded-store" },
    layout_version: { N: "1" },
  },
};
let plans: DynamoDBConfigurationResponsePlan[] = [];
let evidence: Record<string, unknown> = {};

beforeEach(() => {
  plans = [];
  evidence = {};
});
afterEach(async () => {
  const directory = process.env.ESWA_DYNAMODB_EVIDENCE_DIR;
  if (directory === undefined) return;
  const name = expect.getState().currentTestName;
  if (name === undefined) throw new Error("test name unavailable for evidence");
  const fileName = createHash("sha256").update(name).digest("hex").slice(0, 16);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${fileName}.json`),
    JSON.stringify(
      {
        name,
        image: DynamoDBLocal.image,
        ...evidence,
        plans: plans.map((plan) => plan.snapshot()),
      },
      (_key, value) =>
        value instanceof DynamoDBClient
          ? { type: "DynamoDBClient" }
          : value instanceof Error
            ? { ...value, name: value.name, message: value.message }
            : value,
      2,
    ),
  );
});

function recordRequests(
  client: DynamoDBClient,
  hooks?: ConstructorParameters<typeof DynamoDBConfigurationResponsePlan>[1],
) {
  const plan = new DynamoDBConfigurationResponsePlan(client, hooks);
  plans = [...plans, plan];
  return plan;
}

function expectInitialBatch(
  input: unknown,
  tables: DynamoDBEventStoreInput<unknown, unknown>["tables"],
) {
  expect(input).toEqual({
    RequestItems: {
      [tables.journal]: {
        Keys: [{ aid: { S: "__config__" }, seq_nr: { N: "0" } }],
        ConsistentRead: true,
      },
      [tables.snapshot]: {
        Keys: [{ aid: { S: "__config__" }, skey: { N: "0" } }],
        ConsistentRead: true,
      },
      [tables.head]: {
        Keys: [{ aid: { S: "__config__" } }],
        ConsistentRead: true,
      },
    },
  });
}

describe("initializeDynamoDBEventStoreInternal input validation", () => {
  const client = new DynamoDBClient({
    region: "us-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const send = jest.spyOn(client, "send");
  const input = {
    client,
    tables: { journal: "journal", snapshot: "snapshot", head: "head" },
    snapshotAidIndexName: "snapshot-aid-history",
  };
  beforeEach(() => send.mockClear());
  afterAll(() => {
    send.mockRestore();
    client.destroy();
  });

  test.each<[unknown, string]>([
    [undefined, "input"],
    [null, "input"],
    [{ ...input, client: undefined }, "client"],
    [{ ...input, client: {} }, "client"],
    [{ ...input, tables: undefined }, "tables"],
    ...(["journal", "snapshot", "head"] as const).map<[unknown, string]>(
      (table) => [
        { ...input, tables: { ...input.tables, [table]: "" } },
        `tables.${table}`,
      ],
    ),
    [
      { ...input, tables: { journal: "same", snapshot: "same", head: "head" } },
      "tables",
    ],
    [
      {
        ...input,
        tables: { journal: "same", snapshot: "snapshot", head: "same" },
      },
      "tables",
    ],
    [
      {
        ...input,
        tables: { journal: "journal", snapshot: "same", head: "same" },
      },
      "tables",
    ],
    [
      { ...input, tables: { journal: "same", snapshot: "same", head: "same" } },
      "tables",
    ],
    [{ ...input, snapshotAidIndexName: "" }, "snapshotAidIndexName"],
    ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map<[unknown, string]>(
      (retryLimit) => [{ ...input, retryLimit }, "retryLimit"],
    ),
    ...[0, -1, 0.5, Number.NaN].map<[unknown, string]>((count) => [
      { ...input, retention: { count } },
      "retention.count",
    ]),
    [
      { ...input, retention: { count: 1, mode: { type: "other" } } },
      "retention.mode.type",
    ],
    ...[undefined, -1, 0.5, 2 ** 53].map<[unknown, string]>((graceSeconds) => [
      {
        ...input,
        retention: { count: 1, mode: { type: "ttl", graceSeconds } },
      },
      "retention.mode.graceSeconds",
    ]),
    ...[
      "eventSerializer",
      "snapshotSerializer",
      "onRetentionFailure",
      "logger",
    ].map<[unknown, string]>((fieldName) => [
      { ...input, [fieldName]: null },
      fieldName,
    ]),
    [{ ...input, eventSerializer: { serialize() {} } }, "eventSerializer"],
    [
      { ...input, snapshotSerializer: { deserialize() {} } },
      "snapshotSerializer",
    ],
  ])(
    "rejects invalid settings %# before sending",
    async (invalid, fieldName) => {
      const result = await initializeDynamoDBEventStoreInternal(
        invalid as DynamoDBEventStoreInput<unknown, unknown>,
      );

      expect(result).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName },
      });
      expect(send).not.toHaveBeenCalled();
      evidence = { result, sendCount: send.mock.calls.length };
    },
  );
});

describe("initializeDynamoDBEventStoreInternal with DynamoDB Local 3.3.1", () => {
  let local: DynamoDBLocal;
  beforeAll(async () => {
    local = await DynamoDBLocal.start();
  }, 120_000);
  afterAll(async () => {
    if (local !== undefined) await local.stop();
  }, 120_000);

  async function scenario() {
    const layout = await local.createTables();
    const client = local.createClient();
    evidence = { ...evidence, layout };
    return { ...layout, client };
  }

  test("the test owns three independent tables, KEYS_ONLY history GSI, head NEW_IMAGE and snapshot TTL", async () => {
    const input = await scenario();
    const descriptions = await Promise.all(
      Object.values(input.tables).map((TableName) =>
        local.observer.send(new DescribeTableCommand({ TableName })),
      ),
    );
    const ttl = await Promise.all(
      Object.values(input.tables).map((TableName) =>
        local.observer.send(new DescribeTimeToLiveCommand({ TableName })),
      ),
    );

    expect(descriptions[0].Table?.KeySchema).toEqual([
      { AttributeName: "aid", KeyType: "HASH" },
      { AttributeName: "seq_nr", KeyType: "RANGE" },
    ]);
    expect(descriptions[1].Table?.KeySchema).toEqual([
      { AttributeName: "aid", KeyType: "HASH" },
      { AttributeName: "skey", KeyType: "RANGE" },
    ]);
    expect(descriptions[2].Table?.KeySchema).toEqual([
      { AttributeName: "aid", KeyType: "HASH" },
    ]);
    expect(descriptions[0].Table?.AttributeDefinitions).toEqual(
      expect.arrayContaining([
        { AttributeName: "aid", AttributeType: "S" },
        { AttributeName: "seq_nr", AttributeType: "N" },
      ]),
    );
    expect(descriptions[1].Table?.AttributeDefinitions).toEqual(
      expect.arrayContaining([
        { AttributeName: "aid", AttributeType: "S" },
        { AttributeName: "skey", AttributeType: "N" },
        { AttributeName: "active_history_seq_nr", AttributeType: "N" },
      ]),
    );
    expect(descriptions[2].Table?.AttributeDefinitions).toEqual([
      { AttributeName: "aid", AttributeType: "S" },
    ]);
    const indexes = descriptions[1].Table?.GlobalSecondaryIndexes;
    expect(indexes).toHaveLength(1);
    expect(indexes?.[0]).toMatchObject({
      IndexName: input.snapshotAidIndexName,
      KeySchema: [
        { AttributeName: "aid", KeyType: "HASH" },
        { AttributeName: "active_history_seq_nr", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "KEYS_ONLY" },
    });
    for (const description of [descriptions[0], descriptions[1]])
      expect(
        description.Table?.StreamSpecification?.StreamEnabled ?? false,
      ).toBe(false);
    expect(descriptions[2].Table?.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: "NEW_IMAGE",
    });
    expect(ttl[0].TimeToLiveDescription?.TimeToLiveStatus).toBe("DISABLED");
    expect(ttl[1].TimeToLiveDescription).toEqual({
      TimeToLiveStatus: "ENABLED",
      AttributeName: "ttl",
    });
    expect(ttl[2].TimeToLiveDescription?.TimeToLiveStatus).toBe("DISABLED");
    evidence = { ...evidence, descriptions, ttl };
  }, 30_000);

  test("creates exact configuration attributes in a single conditional transaction and preserves them on reopen", async () => {
    const input = await scenario();
    const plan = recordRequests(input.client);

    const opened = await initializeDynamoDBEventStoreInternal(input);
    const saved = await local.readConfiguration(input.tables);

    expect(opened.type).toBe("ok");
    if (opened.type !== "ok") throw new Error("expected initialized settings");
    const storeId = saved.journal.Item?.store_id?.S;
    expect(storeId).toEqual(expect.any(String));
    expect(storeId?.length).toBeGreaterThan(0);
    expect(opened.value.configuration).toEqual({ storeId, layoutVersion: 1 });
    expect(saved.journal.Item).toEqual({
      aid: { S: "__config__" },
      seq_nr: { N: "0" },
      store_id: { S: storeId },
      layout_version: { N: "1" },
    });
    expect(saved.snapshot.Item).toEqual({
      aid: { S: "__config__" },
      skey: { N: "0" },
      store_id: { S: storeId },
      layout_version: { N: "1" },
    });
    expect(saved.head.Item).toEqual({
      aid: { S: "__config__" },
      store_id: { S: storeId },
      layout_version: { N: "1" },
    });
    const requests = plan.snapshot().observations;
    expect(requests.map(({ commandName }) => commandName)).toEqual([
      "BatchGetItemCommand",
      "TransactWriteItemsCommand",
    ]);
    expectInitialBatch(requests[0].input, input.tables);
    const transaction = requests[1].input as TransactWriteItemsCommandInput;
    expect(transaction.TransactItems).toHaveLength(3);
    for (const action of transaction.TransactItems ?? []) {
      expect(action.Put?.ConditionExpression).toBe("attribute_not_exists(aid)");
      const role = (
        Object.keys(input.tables) as (keyof typeof input.tables)[]
      ).find((name) => input.tables[name] === action.Put?.TableName);
      if (role === undefined) throw new Error("unexpected configuration table");
      expect(action.Put?.Item).toEqual(saved[role].Item);
    }
    const reopened = await initializeDynamoDBEventStoreInternal(input);
    const afterReopen = await local.readConfiguration(input.tables);
    expect(reopened).toMatchObject({
      type: "ok",
      value: { configuration: opened.value.configuration },
    });
    expect(
      plan
        .snapshot()
        .observations.slice(2)
        .map(({ commandName }) => commandName),
    ).toEqual(["BatchGetItemCommand"]);
    for (const role of ["journal", "snapshot", "head"] as const)
      expect(afterReopen[role].Item).toEqual(saved[role].Item);
    evidence = { ...evidence, opened, saved, reopened, afterReopen };
  }, 30_000);

  test("independent first creations receive independent random store identifiers", async () => {
    const first = await scenario();
    const second = await scenario();
    recordRequests(first.client);
    recordRequests(second.client);

    const firstResult = await initializeDynamoDBEventStoreInternal(first);
    const secondResult = await initializeDynamoDBEventStoreInternal(second);
    const firstSaved = await local.readConfiguration(first.tables);
    const secondSaved = await local.readConfiguration(second.tables);

    expect(firstResult).toMatchObject({
      type: "ok",
      value: { configuration: { storeId: firstSaved.head.Item?.store_id?.S } },
    });
    expect(secondResult).toMatchObject({
      type: "ok",
      value: { configuration: { storeId: secondSaved.head.Item?.store_id?.S } },
    });
    expect(firstSaved.head.Item?.store_id?.S).not.toBe(
      secondSaved.head.Item?.store_id?.S,
    );
    evidence = {
      first,
      second,
      firstResult,
      secondResult,
      firstSaved,
      secondSaved,
    };
  }, 30_000);

  test("accepts seeded settings and retains validated serializers and retention without invoking them", async () => {
    const input = await scenario();
    await local.seedConfiguration(input.tables, seed);
    const plan = recordRequests(input.client);
    const eventSerializer = { serialize: jest.fn(), deserialize: jest.fn() };
    const snapshotSerializer = { serialize: jest.fn(), deserialize: jest.fn() };
    const onRetentionFailure = jest.fn();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const settings = {
      ...input,
      eventSerializer,
      snapshotSerializer,
      onRetentionFailure,
      logger,
      retention: {
        count: 1,
        mode: { type: "ttl" as const, graceSeconds: Number.MAX_SAFE_INTEGER },
      },
    };
    const saved = await local.readConfiguration(input.tables);

    const result = await initializeDynamoDBEventStoreInternal(settings);

    expect(result.type).toBe("ok");
    if (result.type !== "ok") throw new Error("expected seeded configuration");
    expect(result.value.configuration).toEqual({
      storeId: saved.head.Item?.store_id?.S,
      layoutVersion: 1,
    });
    expect(result.value.settings).toMatchObject({
      retention: settings.retention,
      retryLimit: 5,
    });
    expect(result.value.settings.eventSerializer).toBe(eventSerializer);
    expect(result.value.settings.snapshotSerializer).toBe(snapshotSerializer);
    expect(result.value.settings.onRetentionFailure).toBe(onRetentionFailure);
    expect(result.value.settings.logger).toBe(logger);
    expect(Object.keys(result.value).sort()).toEqual([
      "configuration",
      "getEventsByIdSinceSeqNr",
      "getLatestSnapshotById",
      "persistEvent",
      "persistEventAndSnapshot",
      "settings",
    ]);
    expect(typeof result.value.persistEvent).toBe("function");
    expect(typeof result.value.persistEventAndSnapshot).toBe("function");
    expect(typeof result.value.getEventsByIdSinceSeqNr).toBe("function");
    expect(typeof result.value.getLatestSnapshotById).toBe("function");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.configuration)).toBe(true);
    expect(plan.snapshot().observations).toHaveLength(1);
    expectInitialBatch(plan.snapshot().observations[0].input, input.tables);
    for (const callable of [
      ...Object.values(eventSerializer),
      ...Object.values(snapshotSerializer),
      ...Object.values(logger),
      onRetentionFailure,
    ])
      expect(callable).not.toHaveBeenCalled();
    evidence = { ...evidence, result, saved };
  }, 30_000);

  test("only consumes validated input values after generation starts", async () => {
    const input = await scenario();
    await local.seedConfiguration(input.tables, seed);
    const plan = recordRequests(input.client);
    const getters = Object.fromEntries(
      Object.entries(input).map(([field, value]) => [
        field,
        jest.fn().mockReturnValueOnce(value).mockReturnValue(null),
      ]),
    );
    const changingInput = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(getters).map(([field, get]) => [field, { get }]),
      ),
    );

    const result = await initializeDynamoDBEventStoreInternal(
      changingInput as DynamoDBEventStoreInput<unknown, unknown>,
    );

    expect(result).toMatchObject({ type: "ok" });
    for (const getter of Object.values(getters))
      expect(getter).toHaveBeenCalledTimes(1);
    expectInitialBatch(plan.snapshot().observations[0].input, input.tables);
    evidence = {
      ...evidence,
      result,
      getterCalls: Object.fromEntries(
        Object.entries(getters).map(([field, get]) => [
          field,
          get.mock.calls.length,
        ]),
      ),
    };
  }, 30_000);

  test.each(
    [
      ["journal"],
      ["snapshot"],
      ["head"],
      ["journal", "snapshot"],
      ["journal", "head"],
      ["snapshot", "head"],
    ].map((present) => [present]),
  )(
    "partial settings %p are Configuration and never completed by creation",
    async (present) => {
      const input = await scenario();
      await local.seedConfiguration(
        input.tables,
        Object.fromEntries(
          present.map((name) => [name, seed[name as keyof typeof seed]]),
        ),
      );
      const before = await local.readConfiguration(input.tables);
      const plan = recordRequests(input.client);

      const result = await initializeDynamoDBEventStoreInternal(input);
      const after = await local.readConfiguration(input.tables);

      expect(result).toMatchObject({
        type: "err",
        error: { type: "configuration-error" },
      });
      expect(
        plan.snapshot().observations.map(({ commandName }) => commandName),
      ).toEqual(["BatchGetItemCommand"]);
      for (const role of ["journal", "snapshot", "head"] as const)
        expect(after[role].Item).toEqual(before[role].Item);
      evidence = { ...evidence, before, result, after };
    },
    30_000,
  );

  test.each(["journal", "snapshot", "head"] as const)(
    "a different store_id in %s rejects the seeded tables",
    async (role) => {
      const input = await scenario();
      await local.seedConfiguration(input.tables, {
        ...seed,
        [role]: { ...seed[role], store_id: { S: "different-store" } },
      });
      const plan = recordRequests(input.client);

      const result = await initializeDynamoDBEventStoreInternal(input);

      expect(result).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "store_id" },
      });
      expect(plan.snapshot().observations).toHaveLength(1);
      evidence = {
        ...evidence,
        result,
        saved: await local.readConfiguration(input.tables),
      };
    },
    30_000,
  );

  test.each(["journal", "snapshot", "head", "all"] as const)(
    "unsupported layout_version in %s rejects the seeded tables",
    async (role) => {
      const input = await scenario();
      const items = Object.fromEntries(
        (Object.keys(seed) as (keyof typeof seed)[]).map((name) => [
          name,
          role === "all" || role === name
            ? { ...seed[name], layout_version: { N: "2" } }
            : seed[name],
        ]),
      );
      await local.seedConfiguration(input.tables, items);
      const plan = recordRequests(input.client);

      const result = await initializeDynamoDBEventStoreInternal(input);

      expect(result).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "layout_version" },
      });
      expect(plan.snapshot().observations).toHaveLength(1);
      evidence = {
        ...evidence,
        result,
        saved: await local.readConfiguration(input.tables),
      };
    },
    30_000,
  );

  test.each(
    (["journal", "snapshot", "head"] as const).flatMap((role) =>
      [false, true].map((afterConflict) => [role, afterConflict] as const),
    ),
  )(
    "a near-one layout_version in %s rejects settings (conflict reread: %p)",
    async (role, afterConflict) => {
      const input = await scenario();
      const items = {
        ...seed,
        [role]: { ...seed[role], layout_version: { N: "1.0000000000000001" } },
      };
      let installations = 0;
      const install = async () => {
        await local.seedConfiguration(input.tables, items);
        installations += 1;
      };
      if (!afterConflict) await install();
      const plan = recordRequests(input.client, {
        beforeSend: async (name) => {
          if (afterConflict && name === "TransactWriteItemsCommand")
            await install();
        },
      });

      const result = await initializeDynamoDBEventStoreInternal(input);
      const saved = await local.readConfiguration(input.tables);

      evidence = {
        ...evidence,
        items,
        afterConflict,
        installations,
        result,
        saved,
      };
      expect(saved[role].Item?.layout_version).toEqual({
        N: "1.0000000000000001",
      });
      for (const name of ["journal", "snapshot", "head"] as const)
        expect(saved[name].Item).toEqual(items[name]);
      expect(result.type).toBe("err");
      if (result.type !== "err")
        throw new Error("expected an unsupported version");
      expect(result.error).toMatchObject({
        type: "configuration-error",
        fieldName: "layout_version",
      });
      expect(installations).toBe(1);
      const observations = plan.snapshot().observations;
      expect(observations.map(({ commandName }) => commandName)).toEqual(
        afterConflict
          ? [
              "BatchGetItemCommand",
              "TransactWriteItemsCommand",
              "BatchGetItemCommand",
            ]
          : ["BatchGetItemCommand"],
      );
      expectInitialBatch(observations[0].input, input.tables);
      if (afterConflict) {
        expect(observations[1].error).toBeInstanceOf(
          TransactionCanceledException,
        );
        expect(
          (
            observations[1].error as TransactionCanceledException
          ).CancellationReasons?.some(
            ({ Code }) => Code === "ConditionalCheckFailed",
          ),
        ).toBe(true);
        expectInitialBatch(observations[2].input, input.tables);
      }
      plan.assertApplied();
    },
    30_000,
  );

  test.each(["1.0", "1e0", "0001.000"])(
    "a numeric representation %s of version 1 remains valid on reopen",
    async (number) => {
      const input = await scenario();
      const items = Object.fromEntries(
        Object.entries(seed).map(([role, item]) => [
          role,
          { ...item, layout_version: { N: number } },
        ]),
      );
      await local.seedConfiguration(input.tables, items);
      const before = await local.readConfiguration(input.tables);
      const plan = recordRequests(input.client);

      const opened = await initializeDynamoDBEventStoreInternal(input);
      const reopened = await initializeDynamoDBEventStoreInternal(input);
      const after = await local.readConfiguration(input.tables);

      evidence = { ...evidence, items, before, opened, reopened, after };
      for (const role of ["journal", "snapshot", "head"] as const) {
        expect(before[role].Item?.layout_version).toEqual({ N: "1" });
        expect(after[role].Item).toEqual(before[role].Item);
      }
      expect(opened).toMatchObject({
        type: "ok",
        value: { configuration: { storeId: "seeded-store", layoutVersion: 1 } },
      });
      expect(reopened).toMatchObject({
        type: "ok",
        value: { configuration: { storeId: "seeded-store", layoutVersion: 1 } },
      });
      expect(
        plan.snapshot().observations.map(({ commandName }) => commandName),
      ).toEqual(["BatchGetItemCommand", "BatchGetItemCommand"]);
      plan.assertApplied();
    },
    30_000,
  );

  test.each(
    (["journal", "snapshot", "head"] as const).flatMap((role) =>
      (["store_id", "layout_version"] as const).map(
        (fieldName) => [role, fieldName] as const,
      ),
    ),
  )(
    "configuration in %s missing %s rejects settings without creating",
    async (role, fieldName) => {
      const input = await scenario();
      const incomplete: Record<string, AttributeValue> = { ...seed[role] };
      delete incomplete[fieldName];
      await local.seedConfiguration(input.tables, {
        ...seed,
        [role]: incomplete,
      });
      const before = await local.readConfiguration(input.tables);
      const plan = recordRequests(input.client);

      const result = await initializeDynamoDBEventStoreInternal(input);
      const after = await local.readConfiguration(input.tables);

      expect(result).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName },
      });
      expect(
        plan.snapshot().observations.map(({ commandName }) => commandName),
      ).toEqual(["BatchGetItemCommand"]);
      expect(before[role].Item).toEqual(incomplete);
      for (const name of ["journal", "snapshot", "head"] as const)
        expect(after[name].Item).toEqual(before[name].Item);
      evidence = { ...evidence, before, result, after };
    },
    30_000,
  );

  test("real partial responses accumulate through three requests without creating", async () => {
    const input = await scenario();
    await local.seedConfiguration(input.tables, seed);
    const saved = await local.readConfiguration(input.tables);
    const plan = recordRequests(input.client);
    plan.deferTables([input.tables.snapshot, input.tables.head], 1);
    plan.deferTables([input.tables.head], 1);
    const sleep = jest
      .fn<Promise<void>, [number]>()
      .mockResolvedValue(undefined);

    const result = await initializeDynamoDBEventStoreInternal(input, { sleep });

    expect(result).toMatchObject({
      type: "ok",
      value: { configuration: { storeId: saved.head.Item?.store_id?.S } },
    });
    const requests = plan.snapshot().observations;
    expect(requests.map(({ commandName }) => commandName)).toEqual([
      "BatchGetItemCommand",
      "BatchGetItemCommand",
      "BatchGetItemCommand",
    ]);
    expectInitialBatch(requests[0].input, input.tables);
    expect(
      (requests[1].input as BatchGetItemCommandInput).RequestItems,
    ).toEqual({
      [input.tables.snapshot]: {
        Keys: [{ aid: { S: "__config__" }, skey: { N: "0" } }],
        ConsistentRead: true,
      },
      [input.tables.head]: {
        Keys: [{ aid: { S: "__config__" } }],
        ConsistentRead: true,
      },
    });
    expect(
      (requests[2].input as BatchGetItemCommandInput).RequestItems,
    ).toEqual({
      [input.tables.head]: {
        Keys: [{ aid: { S: "__config__" } }],
        ConsistentRead: true,
      },
    });
    expect(sleep.mock.calls).toEqual([[50], [100]]);
    plan.assertApplied();
    evidence = { ...evidence, saved, result, waits: sleep.mock.calls };
  }, 30_000);

  test.each([0, 1, undefined])(
    "finite retryLimit %p never treats an unresolved key as absent",
    async (retryLimit) => {
      const input = await scenario();
      const plan = recordRequests(input.client);
      const count = (retryLimit ?? 5) + 1;
      plan.deferTables([input.tables.head], count);
      const sleep = jest
        .fn<Promise<void>, [number]>()
        .mockResolvedValue(undefined);

      const result = await initializeDynamoDBEventStoreInternal(
        { ...input, retryLimit },
        { sleep },
      );

      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      if (result.type !== "err") throw new Error("expected retry exhaustion");
      const observations = plan.snapshot().observations;
      expect(observations).toHaveLength(count);
      expect(
        observations.every(
          ({ commandName }) => commandName === "BatchGetItemCommand",
        ),
      ).toBe(true);
      expect(result.error.cause).toEqual(observations[count - 1].returned);
      expect(sleep.mock.calls).toEqual(
        [50, 100, 200, 400, 800].slice(0, count - 1).map((delay) => [delay]),
      );
      const saved = await local.readConfiguration(input.tables);
      for (const entry of Object.values(saved))
        expect(entry.Item).toBeUndefined();
      plan.assertApplied();
      evidence = { ...evidence, result, saved, waits: sleep.mock.calls };
    },
    30_000,
  );

  test("two real creations converge through a real conditional failure and a full strongly consistent reread", async () => {
    const input = await scenario();
    const secondClient = local.createClient();
    let arrivals = 0;
    const readsReady = Promise.withResolvers<void>();
    const firstCommitted = Promise.withResolvers<void>();
    const rendezvous = async (commandName: string) => {
      if (commandName === "TransactWriteItemsCommand") {
        arrivals += 1;
        if (arrivals === 2) readsReady.resolve();
        await readsReady.promise;
      }
    };
    const firstPlan = recordRequests(input.client, { beforeSend: rendezvous });
    const secondPlan = recordRequests(secondClient, {
      beforeSend: async (name) => {
        await rendezvous(name);
        if (name === "TransactWriteItemsCommand") await firstCommitted.promise;
      },
    });
    const firstPromise = initializeDynamoDBEventStoreInternal(input);
    const secondPromise = initializeDynamoDBEventStoreInternal({
      ...input,
      client: secondClient,
    });
    const first = await firstPromise;
    firstCommitted.resolve();
    const second = await secondPromise;
    const saved = await local.readConfiguration(input.tables);

    expect(first).toMatchObject({
      type: "ok",
      value: { configuration: { storeId: saved.head.Item?.store_id?.S } },
    });
    expect(second).toMatchObject({
      type: "ok",
      value: { configuration: { storeId: saved.head.Item?.store_id?.S } },
    });
    expect(arrivals).toBe(2);
    expect(
      firstPlan.snapshot().observations.map(({ commandName }) => commandName),
    ).toEqual(["BatchGetItemCommand", "TransactWriteItemsCommand"]);
    const loser = secondPlan.snapshot().observations;
    expect(loser.map(({ commandName }) => commandName)).toEqual([
      "BatchGetItemCommand",
      "TransactWriteItemsCommand",
      "BatchGetItemCommand",
    ]);
    expect(loser[1].error).toBeInstanceOf(TransactionCanceledException);
    expect(
      (
        loser[1].error as TransactionCanceledException
      ).CancellationReasons?.some(
        ({ Code }) => Code === "ConditionalCheckFailed",
      ),
    ).toBe(true);
    expectInitialBatch(loser[2].input, input.tables);
    firstPlan.assertApplied();
    secondPlan.assertApplied();
    evidence = { ...evidence, first, second, saved, arrivals };
  }, 30_000);

  test("real conditional failure followed by all-absent reread returns Storage without recreating", async () => {
    const input = await scenario();
    const plan = recordRequests(input.client, {
      beforeSend: async (name) => {
        if (name === "TransactWriteItemsCommand")
          await local.seedConfiguration(input.tables, seed);
      },
      onError: async (name, cause) => {
        if (
          name !== "TransactWriteItemsCommand" ||
          !(cause instanceof TransactionCanceledException)
        )
          throw new Error("expected real conditional cancellation");
        for (const role of ["journal", "snapshot", "head"] as const) {
          const key: Record<string, AttributeValue> =
            role === "journal"
              ? { aid: { S: "__config__" }, seq_nr: { N: "0" } }
              : role === "snapshot"
                ? { aid: { S: "__config__" }, skey: { N: "0" } }
                : { aid: { S: "__config__" } };
          await local.observer.send(
            new DeleteItemCommand({ TableName: input.tables[role], Key: key }),
          );
        }
      },
    });

    const result = await initializeDynamoDBEventStoreInternal(input);
    const saved = await local.readConfiguration(input.tables);

    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err")
      throw new Error("expected no configuration after conflict");
    const observations = plan.snapshot().observations;
    expect(observations.map(({ commandName }) => commandName)).toEqual([
      "BatchGetItemCommand",
      "TransactWriteItemsCommand",
      "BatchGetItemCommand",
    ]);
    expect(observations[1].error).toBeInstanceOf(TransactionCanceledException);
    expect(result.error.cause).toBe(observations[1].error);
    expectInitialBatch(observations[2].input, input.tables);
    for (const entry of Object.values(saved))
      expect(entry.Item).toBeUndefined();
    evidence = { ...evidence, result, saved };
  }, 30_000);

  test("a real SDK missing-table failure remains the Storage cause", async () => {
    const input = await scenario();
    const plan = recordRequests(input.client);
    const result = await initializeDynamoDBEventStoreInternal({
      ...input,
      tables: { ...input.tables, head: `${input.tables.head}-missing` },
    });

    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected SDK error");
    const observations = plan.snapshot().observations;
    expect(observations).toHaveLength(1);
    expect(observations[0].error).toBeInstanceOf(ResourceNotFoundException);
    expect(result.error.cause).toBe(observations[0].error);
    evidence = { ...evidence, result };
  }, 30_000);
});
