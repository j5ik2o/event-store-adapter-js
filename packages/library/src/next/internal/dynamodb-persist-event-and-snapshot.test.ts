import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttributeValue,
  type CancellationReason,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactionCanceledException,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import type { EventEnvelope } from "../event-envelope";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import { initializeDynamoDBEventStoreInternal } from "./dynamodb-event-store";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { dynamoDBItemSize } from "./dynamodb-item-size";
import { createDynamoDBPersistEventAndSnapshot } from "./dynamodb-persist-event";
import { DynamoDBLocal } from "./test/dynamodb-local";
import { DynamoDBPersistEventObservation } from "./test/dynamodb-persist-event-observation";

function event(seqNr = 1, overrides: object = {}): EventEnvelope<unknown> {
  return {
    aggregateId: { typeName: "Order", value: "a-b" },
    seqNr,
    occurredAt: new Date("2025-01-02T03:04:05.678Z"),
    manifest: "",
    payload: { count: seqNr },
    ...overrides,
  };
}

function snapshot(
  seqNr = 1,
  overrides: object = {},
): SnapshotEnvelope<unknown> {
  return { seqNr, manifest: "", aggregate: { total: seqNr }, ...overrides };
}

test("the pair factory rejects missing snapshots and mismatched numbers without serialize or SDK IO", async () => {
  const client = new DynamoDBClient({ region: "us-west-1" });
  const send = jest.spyOn(client, "send");
  const serializeEvent = jest.fn();
  const serializeSnapshot = jest.fn();
  const settings = validateDynamoDBEventStoreInput({
    client,
    tables: { journal: "j", snapshot: "s", head: "h" },
    snapshotAidIndexName: "history",
    eventSerializer: { serialize: serializeEvent, deserialize: jest.fn() },
    snapshotSerializer: {
      serialize: serializeSnapshot,
      deserialize: jest.fn(),
    },
  });
  try {
    if (settings.type !== "ok") throw new Error("valid settings expected");
    const persist = createDynamoDBPersistEventAndSnapshot(settings.value);
    expect(
      await persist(event(), undefined as unknown as SnapshotEnvelope),
    ).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "T-10" },
    });
    expect(await persist(event(), snapshot(2))).toMatchObject({
      type: "err",
      error: {
        type: "contract-violation",
        rule: "W-9",
        seqNr: 1,
        snapshotSeqNr: 2,
      },
    });
    expect(serializeEvent).not.toHaveBeenCalled();
    expect(serializeSnapshot).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
    client.destroy();
  }
});

describe("persistEventAndSnapshot from the configured internal entry with DynamoDB Local 3.3.1", () => {
  let local: DynamoDBLocal;
  let evidence: Record<string, unknown>;
  let observations: DynamoDBPersistEventObservation[];
  beforeAll(async () => {
    local = await DynamoDBLocal.start();
  }, 120_000);
  afterAll(async () => {
    if (local !== undefined) await local.stop();
  }, 120_000);
  beforeEach(() => {
    evidence = {};
    observations = [];
  });
  afterEach(async () => {
    const directory = process.env.ESWA_DYNAMODB_EVIDENCE_DIR;
    if (directory === undefined) return;
    const name = expect.getState().currentTestName;
    if (name === undefined) throw new Error("test name unavailable");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(
        directory,
        `${createHash("sha256").update(name).digest("hex").slice(0, 16)}.json`,
      ),
      JSON.stringify(
        {
          name,
          image: DynamoDBLocal.image,
          ...evidence,
          observations: observations.map((observation) =>
            observation.snapshot(),
          ),
        },
        (_key, value) =>
          value instanceof DynamoDBClient
            ? { type: "DynamoDBClient" }
            : value instanceof Uint8Array
              ? {
                  type: "Uint8Array",
                  base64: Buffer.from(value).toString("base64"),
                }
              : value instanceof Error
                ? { ...value, name: value.name, message: value.message }
                : value,
        2,
      ),
    );
  });

  async function scenario(
    options: Partial<
      Pick<
        DynamoDBEventStoreInput<unknown, unknown>,
        | "eventSerializer"
        | "snapshotSerializer"
        | "retention"
        | "onRetentionFailure"
        | "logger"
      >
    > = {},
    beforeSend?: () => Promise<void>,
  ) {
    const layout = await local.createTables();
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client, beforeSend);
    observations = [...observations, observation];
    const opened = await initializeDynamoDBEventStoreInternal({
      ...layout,
      client,
      ...options,
    });
    evidence = { ...evidence, layout, opened };
    if (opened.type !== "ok")
      throw new Error("configuration initialization failed");
    return {
      ...layout,
      client,
      store: opened.value,
      observation,
      initializationRequests: observation.snapshot().observations.length,
    };
  }

  async function readItems(
    tables: { journal: string; snapshot: string; head: string },
    aid = "Order-a-b",
  ) {
    const [journal, snapshots, head] = await Promise.all([
      local.observer.send(
        new QueryCommand({
          TableName: tables.journal,
          KeyConditionExpression: "aid = :aid",
          ExpressionAttributeValues: { ":aid": { S: aid } },
          ConsistentRead: true,
        }),
      ),
      local.observer.send(
        new QueryCommand({
          TableName: tables.snapshot,
          KeyConditionExpression: "aid = :aid",
          ExpressionAttributeValues: { ":aid": { S: aid } },
          ConsistentRead: true,
        }),
      ),
      local.observer.send(
        new GetItemCommand({
          TableName: tables.head,
          Key: { aid: { S: aid } },
          ConsistentRead: true,
        }),
      ),
    ]);
    const physical = {
      journal: journal.Items ?? [],
      snapshots: snapshots.Items ?? [],
      head: head.Item,
    };
    expect(journal.LastEvaluatedKey).toBeUndefined();
    expect(snapshots.LastEvaluatedKey).toBeUndefined();
    evidence = { ...evidence, physical };
    return physical;
  }

  function commits(input: Awaited<ReturnType<typeof scenario>>) {
    const recorded = input.observation
      .snapshot()
      .observations.slice(input.initializationRequests);
    let retentionAllowed = false;
    for (const record of recorded) {
      if (record.commandName === "TransactWriteItemsCommand") {
        retentionAllowed =
          record.upstream !== undefined &&
          (record.input as TransactWriteItemsCommandInput).TransactItems
            ?.length === 4;
      } else {
        expect(retentionAllowed).toBe(true);
        const request = record.input as {
          TableName?: string;
          IndexName?: string;
          RequestItems?: object;
        };
        if (record.commandName === "QueryCommand") {
          expect(request.TableName).toBe(input.tables.snapshot);
          expect(request.IndexName).toBe(input.snapshotAidIndexName);
        } else if (record.commandName === "BatchWriteItemCommand") {
          expect(Object.keys(request.RequestItems ?? {})).toEqual([
            input.tables.snapshot,
          ]);
        } else {
          expect(record.commandName).toBe("UpdateItemCommand");
          expect(request.TableName).toBe(input.tables.snapshot);
        }
      }
    }
    return recorded.filter(
      ({ commandName }) => commandName === "TransactWriteItemsCommand",
    );
  }

  test.each([
    undefined,
    { count: 1 },
    { count: 1, mode: { type: "ttl" as const, graceSeconds: 0 } },
  ])(
    "creates and appends a complete pair on the same handle with retention %j",
    async (retention) => {
      const onRetentionFailure = jest.fn();
      const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const input = await scenario({ retention, onRetentionFailure, logger });
      const userString = jest.fn().mockReturnValue("not-the-aid");
      const first = await input.store.persistEventAndSnapshot(
        event(1, {
          aggregateId: {
            typeName: "Order",
            value: "a-b",
            asString: userString,
          },
        }),
        snapshot(),
      );
      const afterFirst = await readItems(input.tables);
      const second = await input.store.persistEventAndSnapshot(
        event(2, {
          occurredAt: new Date(-1),
          manifest: "イベント/v2",
        }),
        snapshot(2, { manifest: "集約/v2" }),
      );
      const after = await readItems(input.tables);
      evidence = { ...evidence, first, afterFirst, second, after };
      expect(first).toEqual({ type: "ok", value: undefined });
      expect(second).toEqual({ type: "ok", value: undefined });
      expect(userString).not.toHaveBeenCalled();
      const firstFields = {
        seq_nr: { N: "1" },
        occurred_at: { N: "1735787045678000000" },
        manifest: { S: "" },
        payload: { B: Buffer.from('{"count":1}') },
      };
      const secondFields = {
        seq_nr: { N: "2" },
        occurred_at: { N: "-1000000" },
        manifest: { S: "イベント/v2" },
        payload: { B: Buffer.from('{"count":2}') },
      };
      const firstSnapshot = {
        aid: { S: "Order-a-b" },
        skey: { N: "0" },
        seq_nr: { N: "1" },
        last_updated_at: { N: "1735787045678" },
        manifest: { S: "" },
        payload: { B: Buffer.from('{"total":1}') },
      };
      const secondSnapshot = {
        aid: { S: "Order-a-b" },
        skey: { N: "0" },
        seq_nr: { N: "2" },
        last_updated_at: { N: "-1" },
        manifest: { S: "集約/v2" },
        payload: { B: Buffer.from('{"total":2}') },
      };
      expect(afterFirst).toEqual({
        journal: [{ aid: { S: "Order-a-b" }, ...firstFields }],
        head: {
          aid: { S: "Order-a-b" },
          type_name: { S: "Order" },
          seq_nr: { N: "1" },
          events: { L: [{ M: firstFields }] },
        },
        snapshots: [
          firstSnapshot,
          ...(retention === undefined
            ? []
            : [
                {
                  ...firstSnapshot,
                  skey: { N: "1" },
                  active_history_seq_nr: { N: "1" },
                },
              ]),
        ],
      });
      expect(after).toEqual({
        journal: [
          afterFirst.journal[0],
          { aid: { S: "Order-a-b" }, ...secondFields },
        ],
        head: {
          aid: { S: "Order-a-b" },
          type_name: { S: "Order" },
          seq_nr: { N: "2" },
          events: { L: [{ M: secondFields }] },
        },
        snapshots: [
          secondSnapshot,
          ...(retention?.mode?.type === "ttl"
            ? [
                {
                  ...firstSnapshot,
                  skey: { N: "1" },
                  ttl: { N: expect.any(String) },
                },
              ]
            : []),
          ...(retention === undefined
            ? []
            : [
                {
                  ...secondSnapshot,
                  skey: { N: "2" },
                  active_history_seq_nr: { N: "2" },
                },
              ]),
        ],
      });
      const requests = commits(input);
      expect(requests).toHaveLength(2);
      const create = requests[0].input as TransactWriteItemsCommandInput;
      const update = requests[1].input as TransactWriteItemsCommandInput;
      expect(create.TransactItems?.[0].Put).toEqual({
        TableName: input.tables.journal,
        Item: afterFirst.journal[0],
        ConditionExpression: "attribute_not_exists(aid)",
      });
      expect(create.TransactItems?.[1].Put).toEqual({
        TableName: input.tables.head,
        Item: afterFirst.head,
        ConditionExpression: "attribute_not_exists(aid)",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      });
      expect(update.TransactItems?.[1].Update).toEqual({
        TableName: input.tables.head,
        Key: { aid: { S: "Order-a-b" } },
        ConditionExpression: "seq_nr = :prev",
        UpdateExpression: "SET seq_nr = :seq, #events = :events",
        ExpressionAttributeNames: { "#events": "events" },
        ExpressionAttributeValues: {
          ":prev": { N: "1" },
          ":seq": { N: "2" },
          ":events": { L: [{ M: secondFields }] },
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      });
      for (const [index, request] of requests.entries()) {
        const items = (request.input as TransactWriteItemsCommandInput)
          .TransactItems;
        expect(items).toHaveLength(retention === undefined ? 3 : 4);
        const current = index === 0 ? firstSnapshot : secondSnapshot;
        expect(items?.[2].Put).toEqual({
          TableName: input.tables.snapshot,
          Item: current,
        });
        if (retention !== undefined)
          expect(items?.[3].Put).toEqual({
            TableName: input.tables.snapshot,
            Item: {
              ...current,
              skey: current.seq_nr,
              active_history_seq_nr: current.seq_nr,
            },
          });
        const wire = JSON.parse(request.wireBody as string);
        expect(wire.TransactItems).toHaveLength(
          retention === undefined ? 3 : 4,
        );
        expect(wire.TransactItems[2].Put.Item.payload).toEqual({
          B: current.payload.B.toString("base64"),
        });
        expect(request.upstream).toMatchObject({
          $metadata: { httpStatusCode: 200, attempts: 1 },
        });
      }
      expect(onRetentionFailure).not.toHaveBeenCalled();
      for (const call of Object.values(logger))
        expect(call).not.toHaveBeenCalled();
      input.observation.assertApplied();
    },
    30_000,
  );

  test("pair and single appends keep snapshots unchanged across the single operations", async () => {
    const input = await scenario({ retention: { count: 1 } });
    expect(
      await input.store.persistEventAndSnapshot(event(), snapshot()),
    ).toMatchObject({ type: "ok" });
    const afterPair = await readItems(input.tables);
    expect(await input.store.persistEvent(event(2))).toMatchObject({
      type: "ok",
    });
    const afterSingle = await readItems(input.tables);
    expect(afterSingle.snapshots).toEqual(afterPair.snapshots);
    expect(
      await input.store.persistEventAndSnapshot(event(3), snapshot(3)),
    ).toMatchObject({ type: "ok" });
    const afterSecondPair = await readItems(input.tables);
    expect(await input.store.persistEvent(event(4))).toMatchObject({
      type: "ok",
    });
    const after = await readItems(input.tables);
    evidence = { ...evidence, afterPair, afterSingle, afterSecondPair, after };
    expect(after.snapshots).toEqual(afterSecondPair.snapshots);
    expect(after.snapshots.map((item) => item.skey)).toEqual([
      { N: "0" },
      { N: "3" },
    ]);
    expect(after.head?.seq_nr).toEqual({ N: "4" });
    expect(after.journal.map((item) => item.seq_nr)).toEqual(
      [1, 2, 3, 4].map((seqNr) => ({ N: seqNr.toString() })),
    );
    expect(
      commits(input).map(
        (request) =>
          (request.input as TransactWriteItemsCommandInput).TransactItems
            ?.length,
      ),
    ).toEqual([4, 2, 4, 2]);
  }, 30_000);

  test.each<[string, object, object, string]>([
    ["mismatched numbers", {}, { seqNr: 2 }, "W-9"],
    ["event zero", { seqNr: 0 }, {}, "W-6"],
    ["event negative", { seqNr: -1 }, {}, "T-9"],
    ["event fraction", { seqNr: 1.5 }, {}, "T-9"],
    ["event unsafe", { seqNr: 2 ** 53 }, {}, "T-9"],
    ["snapshot negative", {}, { seqNr: -1 }, "T-9"],
    ["snapshot fraction", {}, { seqNr: 1.5 }, "T-9"],
    ["snapshot unsafe", {}, { seqNr: 2 ** 53 }, "T-9"],
    ["missing aggregateId", { aggregateId: undefined }, {}, "T-2"],
    ["missing event number", { seqNr: undefined }, {}, "T-2"],
    ["missing event time", { occurredAt: undefined }, {}, "T-2"],
    ["missing event payload", { payload: undefined }, {}, "T-2"],
    ["missing snapshot number", {}, { seqNr: undefined }, "T-10"],
    ["missing snapshot aggregate", {}, { aggregate: undefined }, "T-10"],
    [
      "invalid type name",
      { aggregateId: { typeName: "Order-Item", value: "1" } },
      {},
      "T-11",
    ],
    [
      "UTF-8 aid over limit",
      { aggregateId: { typeName: "Order", value: "あ".repeat(340) } },
      {},
      "T-12",
    ],
    ["invalid Date", { occurredAt: new Date(Number.NaN) }, {}, "T-13"],
    ["out of range Date", { occurredAt: new Date("2263-01-01") }, {}, "T-13"],
  ])(
    "rejects %s before either serializer or send",
    async (_name, eventOverrides, snapshotOverrides, rule) => {
      const serializeEvent = jest.fn();
      const serializeSnapshot = jest.fn();
      const input = await scenario({
        eventSerializer: { serialize: serializeEvent, deserialize: jest.fn() },
        snapshotSerializer: {
          serialize: serializeSnapshot,
          deserialize: jest.fn(),
        },
      });
      const result = await input.store.persistEventAndSnapshot(
        event(1, eventOverrides),
        snapshot(1, snapshotOverrides),
      );
      const physical = await readItems(input.tables);
      evidence = {
        ...evidence,
        result,
        serializeCalls: [
          serializeEvent.mock.calls.length,
          serializeSnapshot.mock.calls.length,
        ],
      };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule },
      });
      if (result.type !== "err") throw new Error("expected invalid input");
      expect(result.error.message).toContain(rule);
      if (rule === "W-9") {
        expect(result.error).toMatchObject({ seqNr: 1, snapshotSeqNr: 2 });
        expect(result.error.message).toContain("1");
        expect(result.error.message).toContain("2");
      }
      expect(serializeEvent).not.toHaveBeenCalled();
      expect(serializeSnapshot).not.toHaveBeenCalled();
      expect(commits(input)).toHaveLength(0);
      expect(physical).toEqual({ journal: [], snapshots: [], head: undefined });
    },
    30_000,
  );

  test.each(
    ["event", "snapshot"].flatMap((target) =>
      ["throw", "invalid bytes"].map((mode) => [target, mode]),
    ),
  )(
    "%s serializer %s sends zero and preserves an existing complete pair",
    async (target, mode) => {
      const serializeEvent = jest.fn(
        (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value)),
      );
      const serializeSnapshot = jest.fn(
        (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value)),
      );
      const input = await scenario({
        retention: { count: 1 },
        eventSerializer: { serialize: serializeEvent, deserialize: jest.fn() },
        snapshotSerializer: {
          serialize: serializeSnapshot,
          deserialize: jest.fn(),
        },
      });
      expect(
        await input.store.persistEventAndSnapshot(event(), snapshot()),
      ).toMatchObject({ type: "ok" });
      const before = await readItems(input.tables);
      serializeEvent.mockClear();
      serializeSnapshot.mockClear();
      const cause = new Error("serializer failure");
      (target === "event"
        ? serializeEvent
        : serializeSnapshot
      ).mockImplementation(() => {
        if (mode === "throw") throw cause;
        return "invalid" as unknown as Uint8Array;
      });
      const result = await input.store.persistEventAndSnapshot(
        event(2),
        snapshot(2),
      );
      const after = await readItems(input.tables);
      evidence = {
        ...evidence,
        before,
        result,
        after,
        cause,
        serializeCalls: [
          serializeEvent.mock.calls.length,
          serializeSnapshot.mock.calls.length,
        ],
      };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "serialization-error", operation: "serialize" },
      });
      if (result.type !== "err")
        throw new Error("expected serialization failure");
      if (mode === "throw") expect(result.error.cause).toBe(cause);
      else expect(result.error.cause).toBeInstanceOf(TypeError);
      expect(serializeEvent).toHaveBeenCalledTimes(1);
      expect(serializeSnapshot).toHaveBeenCalledTimes(
        target === "event" ? 0 : 1,
      );
      expect(commits(input)).toHaveLength(1);
      expect(after).toEqual(before);
    },
    30_000,
  );

  test.each([1, 2, 4])(
    "real head failure at sequence %i returns ALL_OLD and leaves every item unchanged",
    async (seqNr) => {
      const input = await scenario({ retention: { count: 1 } });
      for (const seq of [1, 2])
        expect(
          await input.store.persistEventAndSnapshot(event(seq), snapshot(seq)),
        ).toMatchObject({ type: "ok" });
      const before = await readItems(input.tables);
      const result = await input.store.persistEventAndSnapshot(
        event(seqNr, { payload: "loser" }),
        snapshot(seqNr, { aggregate: "loser" }),
      );
      const after = await readItems(input.tables);
      evidence = { ...evidence, before, result, after };
      expect(result).toMatchObject({
        type: "err",
        error:
          seqNr === 4
            ? { type: "contract-violation", rule: "W-8", seqNr }
            : {
                type: "optimistic-lock-conflict",
                aggregateId: "Order-a-b",
                seqNr,
                headSeqNr: 2,
              },
      });
      const requests = commits(input);
      expect(requests).toHaveLength(3);
      const cause = requests[2].error;
      if (
        !(cause instanceof TransactionCanceledException) ||
        result.type !== "err"
      )
        throw new Error("expected cancellation");
      expect(cause.CancellationReasons).toHaveLength(4);
      expect(cause.CancellationReasons?.[1].Code).toBe(
        "ConditionalCheckFailed",
      );
      expect(cause.CancellationReasons?.[1].Item).toEqual(before.head);
      expect(result.error.cause).toBe(cause);
      expect(after).toEqual(before);
    },
    30_000,
  );

  test("a missing real head is a W-8 gap with no classification read or partial pair", async () => {
    const input = await scenario();
    const result = await input.store.persistEventAndSnapshot(
      event(2),
      snapshot(2),
    );
    const physical = await readItems(input.tables);
    evidence = { ...evidence, result };
    expect(result).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-8", seqNr: 2 },
    });
    const requests = commits(input);
    expect(requests).toHaveLength(1);
    const cause = requests[0].error;
    if (
      !(cause instanceof TransactionCanceledException) ||
      result.type !== "err"
    )
      throw new Error("expected cancellation");
    expect(cause.CancellationReasons?.map(({ Code }) => Code)).toEqual([
      "None",
      "ConditionalCheckFailed",
      "None",
    ]);
    expect(cause.CancellationReasons?.[1].Item).toBeUndefined();
    expect(result.error.cause).toBe(cause);
    expect(physical).toEqual({ journal: [], snapshots: [], head: undefined });
  }, 30_000);

  test("a real journal condition failure cancels the head update and both snapshot writes", async () => {
    const input = await scenario({ retention: { count: 1 } });
    expect(
      await input.store.persistEventAndSnapshot(event(), snapshot()),
    ).toMatchObject({ type: "ok" });
    const seeded = {
      aid: { S: "Order-a-b" },
      seq_nr: { N: "2" },
      occurred_at: { N: "0" },
      manifest: { S: "seed" },
      payload: { B: Buffer.from("seed") },
    };
    await local.observer.send(
      new PutItemCommand({ TableName: input.tables.journal, Item: seeded }),
    );
    const before = await readItems(input.tables);
    const result = await input.store.persistEventAndSnapshot(
      event(2),
      snapshot(2),
    );
    const after = await readItems(input.tables);
    evidence = { ...evidence, before, result, after };
    expect(result).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", seqNr: 2 },
    });
    const requests = commits(input);
    expect(requests).toHaveLength(2);
    const cause = requests[1].error;
    if (
      !(cause instanceof TransactionCanceledException) ||
      result.type !== "err"
    )
      throw new Error("expected cancellation");
    expect(cause.CancellationReasons?.map(({ Code }) => Code)).toEqual([
      "ConditionalCheckFailed",
      "None",
      "None",
      "None",
    ]);
    expect(result.error.cause).toBe(cause);
    expect(after).toEqual(before);
  }, 30_000);

  test.each([
    "journal payload",
    "event manifest",
    "head overhead",
    "current payload",
    "snapshot manifest",
    "history overhead",
  ])(
    "rejects %s above the item upper bound with zero new sends",
    async (kind) => {
      let eventBytes = new Uint8Array();
      let snapshotBytes = new Uint8Array();
      const input = await scenario({
        retention: { count: 1 },
        eventSerializer: {
          serialize: () => eventBytes,
          deserialize: jest.fn(),
        },
        snapshotSerializer: {
          serialize: () => snapshotBytes,
          deserialize: jest.fn(),
        },
      });
      expect(
        await input.store.persistEventAndSnapshot(event(), snapshot()),
      ).toMatchObject({ type: "ok" });
      const before = await readItems(input.tables);
      const fields = {
        seq_nr: { N: "2" },
        occurred_at: { N: "1735787045678000000" },
        manifest: { S: kind === "event manifest" ? "あ".repeat(136_534) : "" },
        payload: { B: eventBytes },
      };
      const current = {
        aid: { S: "Order-a-b" },
        skey: { N: "0" },
        seq_nr: { N: "2" },
        last_updated_at: { N: "1735787045678" },
        manifest: {
          S: kind === "snapshot manifest" ? "あ".repeat(136_534) : "",
        },
        payload: { B: snapshotBytes },
      };
      const head = {
        aid: { S: "Order-a-b" },
        type_name: { S: "Order" },
        seq_nr: fields.seq_nr,
        events: { L: [{ M: fields }] },
      };
      const history = {
        ...current,
        skey: { N: "2" },
        active_history_seq_nr: { N: "2" },
      };
      if (kind === "journal payload") eventBytes = new Uint8Array(409600);
      if (kind === "head overhead")
        eventBytes = new Uint8Array(409600 - dynamoDBItemSize(head) + 1);
      if (kind === "current payload")
        snapshotBytes = new Uint8Array(409600 - dynamoDBItemSize(current) + 1);
      if (kind === "history overhead")
        snapshotBytes = new Uint8Array(409600 - dynamoDBItemSize(history) + 1);
      const candidateFields = { ...fields, payload: { B: eventBytes } };
      const sizes = {
        journal: dynamoDBItemSize({
          aid: { S: "Order-a-b" },
          ...candidateFields,
        }),
        head: dynamoDBItemSize({
          ...head,
          events: { L: [{ M: candidateFields }] },
        }),
        current: dynamoDBItemSize({
          ...current,
          payload: { B: snapshotBytes },
        }),
        history: dynamoDBItemSize({
          ...history,
          payload: { B: snapshotBytes },
        }),
      };
      if (kind === "head overhead") {
        expect(sizes.journal).toBeLessThanOrEqual(409600);
        expect(sizes.head).toBe(409601);
      }
      if (kind === "history overhead") {
        expect(sizes.current).toBeLessThanOrEqual(409600);
        expect(sizes.history).toBe(409601);
      }
      expect(Math.max(...Object.values(sizes))).toBeGreaterThan(409600);
      const result = await input.store.persistEventAndSnapshot(
        event(2, { manifest: fields.manifest.S }),
        snapshot(2, { manifest: current.manifest.S }),
      );
      const after = await readItems(input.tables);
      evidence = { ...evidence, before, sizes, result, after };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule: "D-7", seqNr: 2 },
      });
      expect(commits(input)).toHaveLength(1);
      expect(after).toEqual(before);
    },
    30_000,
  );

  test.each(["head", "current", "history"])(
    "the exact %s item upper bound of 409600 is writable",
    async (target) => {
      const fields = {
        seq_nr: { N: "1" },
        occurred_at: { N: "1735787045678000000" },
        manifest: { S: "" },
        payload: { B: new Uint8Array() },
      };
      const current = {
        aid: { S: "Order-a-b" },
        skey: { N: "0" },
        seq_nr: { N: "1" },
        last_updated_at: { N: "1735787045678" },
        manifest: { S: "" },
        payload: { B: new Uint8Array() },
      };
      const empty: Record<string, AttributeValue> =
        target === "head"
          ? {
              aid: { S: "Order-a-b" },
              type_name: { S: "Order" },
              seq_nr: fields.seq_nr,
              events: { L: [{ M: fields }] },
            }
          : target === "current"
            ? current
            : {
                ...current,
                skey: { N: "1" },
                active_history_seq_nr: { N: "1" },
              };
      const bytes = new Uint8Array(409600 - dynamoDBItemSize(empty));
      const input = await scenario({
        retention: target === "current" ? undefined : { count: 1 },
        eventSerializer: {
          serialize: () => (target === "head" ? bytes : new Uint8Array()),
          deserialize: jest.fn(),
        },
        snapshotSerializer: {
          serialize: () => (target === "head" ? new Uint8Array() : bytes),
          deserialize: jest.fn(),
        },
      });
      const result = await input.store.persistEventAndSnapshot(
        event(),
        snapshot(),
      );
      const physical = await readItems(input.tables);
      evidence = { ...evidence, result, payloadBytes: bytes.byteLength };
      expect(result).toMatchObject({ type: "ok" });
      const item =
        target === "head"
          ? physical.head
          : physical.snapshots[target === "current" ? 0 : 1];
      if (item === undefined) throw new Error("expected boundary item");
      expect(dynamoDBItemSize(item)).toBe(409600);
      const request = commits(input)[0];
      expect(
        (request.input as TransactWriteItemsCommandInput).TransactItems,
      ).toHaveLength(target === "current" ? 3 : 4);
      expect(request.upstream).toMatchObject({
        $metadata: { httpStatusCode: 200, attempts: 1 },
      });
    },
    30_000,
  );

  test("arbitrary domain values, shared scratch views and metadata stay independent across serializers and the pending send", async () => {
    class DomainEvent {
      constructor(private readonly amount: bigint) {}
      encode() {
        return `event:${this.amount}`;
      }
    }
    const payload = new DomainEvent(BigInt(7));
    const aggregate = {
      amount: BigInt(8),
      encode() {
        return `state:${this.amount}`;
      },
    };
    const backing = Buffer.from("--event:7--");
    const returned = backing.subarray(2, 9);
    const rawEvent = { ...event(1, { payload, manifest: "domain/event" }) };
    const rawSnapshot = {
      ...snapshot(1, { aggregate, manifest: "domain/snapshot" }),
    };
    const serializeEvent = jest.fn((value: unknown) => {
      if (!(value instanceof DomainEvent))
        throw new TypeError("domain event expected");
      expect(value.encode()).toBe("event:7");
      rawEvent.aggregateId = { typeName: "Changed", value: "changed" };
      rawEvent.seqNr = 99;
      rawEvent.occurredAt.setTime(0);
      rawEvent.manifest = "changed-event";
      rawSnapshot.seqNr = 99;
      rawSnapshot.manifest = "changed-snapshot";
      rawSnapshot.aggregate = null;
      return returned;
    });
    const serializeSnapshot = jest.fn((value: unknown) => {
      expect(value).toBe(aggregate);
      returned.set(Buffer.from(aggregate.encode()));
      return returned;
    });
    const deserializeEvent = jest.fn();
    const deserializeSnapshot = jest.fn();
    const input = await scenario({
      retention: { count: 1 },
      eventSerializer: {
        serialize: serializeEvent,
        deserialize: deserializeEvent,
      },
      snapshotSerializer: {
        serialize: serializeSnapshot,
        deserialize: deserializeSnapshot,
      },
    });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const actualSend = input.client.send.bind(input.client);
    const send = jest
      .spyOn(input.client, "send")
      .mockImplementation(async (command) => {
        ready.resolve();
        await release.promise;
        return actualSend(command);
      });
    try {
      const pending = input.store.persistEventAndSnapshot(
        rawEvent,
        rawSnapshot,
      );
      await ready.promise;
      expect(serializeEvent).toHaveBeenCalledTimes(1);
      expect(serializeSnapshot).toHaveBeenCalledTimes(1);
      returned.fill(0);
      rawEvent.payload = null;
      rawEvent.manifest = "changed-while-pending";
      rawSnapshot.manifest = "changed-while-pending";
      release.resolve();
      const result = await pending;
      const physical = await readItems(input.tables);
      evidence = {
        ...evidence,
        result,
        changedBytes: returned,
        serializeCalls: [
          serializeEvent.mock.calls.length,
          serializeSnapshot.mock.calls.length,
        ],
      };
      expect(result).toMatchObject({ type: "ok" });
      expect(serializeEvent).toHaveBeenCalledWith(payload);
      expect(deserializeEvent).not.toHaveBeenCalled();
      expect(deserializeSnapshot).not.toHaveBeenCalled();
      const fields = {
        seq_nr: { N: "1" },
        occurred_at: { N: "1735787045678000000" },
        manifest: { S: "domain/event" },
        payload: { B: Buffer.from("event:7") },
      };
      const current = {
        aid: { S: "Order-a-b" },
        skey: { N: "0" },
        seq_nr: { N: "1" },
        last_updated_at: { N: "1735787045678" },
        manifest: { S: "domain/snapshot" },
        payload: { B: Buffer.from("state:8") },
      };
      expect(physical).toEqual({
        journal: [{ aid: { S: "Order-a-b" }, ...fields }],
        head: {
          aid: { S: "Order-a-b" },
          type_name: { S: "Order" },
          seq_nr: { N: "1" },
          events: { L: [{ M: fields }] },
        },
        snapshots: [
          current,
          { ...current, skey: { N: "1" }, active_history_seq_nr: { N: "1" } },
        ],
      });
      expect(commits(input)).toHaveLength(1);
    } finally {
      release.resolve();
      send.mockRestore();
    }
  }, 30_000);

  test.each([1, 2])(
    "two independent clients competing for sequence %i commit exactly one complete pair",
    async (seqNr) => {
      let active = false;
      let arrivals = 0;
      const ready = Promise.withResolvers<void>();
      const gate = async () => {
        if (!active) return;
        arrivals += 1;
        if (arrivals === 2) ready.resolve();
        await ready.promise;
      };
      const input = await scenario({ retention: { count: 1 } }, gate);
      if (seqNr === 2)
        expect(
          await input.store.persistEventAndSnapshot(event(), snapshot()),
        ).toMatchObject({ type: "ok" });
      const secondClient = local.createClient();
      const secondObservation = new DynamoDBPersistEventObservation(
        secondClient,
        gate,
      );
      observations = [...observations, secondObservation];
      const opened = await initializeDynamoDBEventStoreInternal({
        ...input,
        client: secondClient,
        retention: { count: 1 },
      });
      if (opened.type !== "ok") throw new Error("expected second writer");
      const secondOffset = secondObservation.snapshot().observations.length;
      const before = await readItems(input.tables);
      active = true;
      const results = await Promise.all(
        [input.store, opened.value].map((store, writer) =>
          store.persistEventAndSnapshot(
            event(seqNr, { payload: { writer } }),
            snapshot(seqNr, { aggregate: { writer } }),
          ),
        ),
      );
      const after = await readItems(input.tables);
      evidence = { ...evidence, before, results, after, arrivals };
      expect(arrivals).toBe(2);
      expect(results.filter(({ type }) => type === "ok")).toHaveLength(1);
      const winner = results.findIndex(({ type }) => type === "ok");
      const loser = results[1 - winner];
      expect(loser).toMatchObject({
        type: "err",
        error: { type: "optimistic-lock-conflict" },
      });
      if (loser.type !== "err") throw new Error("expected loser");
      const firstRequests = commits(input);
      const secondRequests = commits({
        ...input,
        observation: secondObservation,
        initializationRequests: secondOffset,
      });
      expect(firstRequests).toHaveLength(seqNr);
      expect(secondRequests).toHaveLength(1);
      const cause =
        winner === 0 ? secondRequests[0].error : firstRequests[seqNr - 1].error;
      expect(cause).toBeInstanceOf(TransactionCanceledException);
      expect(loser.error.cause).toBe(cause);
      const bytes = { B: Buffer.from(JSON.stringify({ writer: winner })) };
      expect(after.journal).toHaveLength(seqNr);
      expect(after.journal[seqNr - 1].payload).toEqual(bytes);
      expect(after.head?.seq_nr).toEqual({ N: seqNr.toString() });
      expect(after.head?.events?.L?.[0].M?.payload).toEqual(bytes);
      expect(after.snapshots).toHaveLength(2);
      for (const item of after.snapshots) {
        expect(item.seq_nr).toEqual({ N: seqNr.toString() });
        expect(item.payload).toEqual(bytes);
      }
      if (seqNr === 2) {
        expect(after.journal[0]).toEqual(before.journal[0]);
      }
      input.observation.assertApplied();
      secondObservation.assertApplied();
    },
    30_000,
  );

  test.each(
    [3, 4].flatMap((count) =>
      Array.from({ length: count }, (_, position) => [count, position]),
    ),
  )(
    "a %i-action request prioritizes Conflict at position %i over other cancellation reasons",
    async (count, position) => {
      const input = await scenario({
        retention: count === 4 ? { count: 1 } : undefined,
      });
      const reasons: CancellationReason[] = Array.from(
        { length: count },
        (_, index) =>
          index === 0
            ? { Code: "ConditionalCheckFailed" }
            : index === 1
              ? { Code: "ConditionalCheckFailed", Item: { seq_nr: { N: "1" } } }
              : { Code: "ThrottlingError" },
      );
      const CancellationReasons = reasons.map((reason, index) =>
        index === position ? { Code: "TransactionConflict" } : reason,
      );
      const cause = new TransactionCanceledException({
        $metadata: {},
        message: "sdk-private-diagnostic",
        CancellationReasons,
      });
      input.observation.failNext(cause);
      const result = await input.store.persistEventAndSnapshot(
        event(4),
        snapshot(4),
      );
      const physical = await readItems(input.tables);
      evidence = { ...evidence, result, cause };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "optimistic-lock-conflict", seqNr: 4 },
      });
      if (result.type !== "err") throw new Error("expected conflict");
      expect(result.error.cause).toBe(cause);
      expect(result.error.message).not.toContain(cause.message);
      const requests = commits(input);
      expect(requests).toHaveLength(1);
      expect(
        (requests[0].input as TransactWriteItemsCommandInput).TransactItems,
      ).toHaveLength(count);
      expect(requests[0].upstream).toBeUndefined();
      expect(physical).toEqual({ journal: [], snapshots: [], head: undefined });
      input.observation.assertApplied();
    },
    30_000,
  );

  test.each<[string, CancellationReason[], string]>([
    [
      "head gap before journal condition",
      [
        { Code: "ConditionalCheckFailed" },
        { Code: "ConditionalCheckFailed", Item: { seq_nr: { N: "1" } } },
        { Code: "ThrottlingError" },
        { Code: "None" },
      ],
      "contract-violation",
    ],
    [
      "journal condition before snapshot throttle",
      [
        { Code: "ConditionalCheckFailed" },
        { Code: "None" },
        { Code: "ThrottlingError" },
        { Code: "None" },
      ],
      "optimistic-lock-conflict",
    ],
    [
      "current throttle",
      [
        { Code: "None" },
        { Code: "None" },
        { Code: "ThrottlingError" },
        { Code: "None" },
      ],
      "storage-error",
    ],
    [
      "history throttle",
      [
        { Code: "None" },
        { Code: "None" },
        { Code: "None" },
        { Code: "ThrottlingError" },
      ],
      "storage-error",
    ],
  ])(
    "replace-request %s preserves priority, cause and the existing complete pair",
    async (_name, CancellationReasons, type) => {
      const input = await scenario({ retention: { count: 1 } });
      expect(
        await input.store.persistEventAndSnapshot(event(), snapshot()),
      ).toMatchObject({ type: "ok" });
      const before = await readItems(input.tables);
      const cause = new TransactionCanceledException({
        $metadata: {},
        message: "sdk-private-diagnostic",
        CancellationReasons,
      });
      input.observation.failNext(cause);
      const result = await input.store.persistEventAndSnapshot(
        event(4),
        snapshot(4),
      );
      const after = await readItems(input.tables);
      evidence = { ...evidence, before, result, after, cause };
      expect(result).toMatchObject({ type: "err", error: { type } });
      if (result.type !== "err") throw new Error("expected cancellation");
      if (type === "contract-violation")
        expect(result.error).toMatchObject({ rule: "W-8", seqNr: 4 });
      expect(result.error.cause).toBe(cause);
      expect(result.error.message).not.toContain(cause.message);
      expect(commits(input)).toHaveLength(2);
      expect(after).toEqual(before);
      input.observation.assertApplied();
    },
    30_000,
  );

  test("a non-cancellation storage failure preserves cause and sends no follow-up IO", async () => {
    const input = await scenario();
    const cause = new Error("planned transport failure");
    input.observation.failNext(cause);
    const result = await input.store.persistEventAndSnapshot(
      event(),
      snapshot(),
    );
    const physical = await readItems(input.tables);
    evidence = { ...evidence, result, cause };
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected storage failure");
    expect(result.error.cause).toBe(cause);
    expect(commits(input)).toHaveLength(1);
    expect(physical).toEqual({ journal: [], snapshots: [], head: undefined });
    input.observation.assertApplied();
  }, 30_000);
});
