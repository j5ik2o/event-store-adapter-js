import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttributeValue,
  type CancellationReason,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactionCanceledException,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { EventEnvelope } from "../event-envelope";
import type { PayloadSerializer } from "../payload-serializer";
import { initializeDynamoDBEventStoreInternal } from "./dynamodb-event-store";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { dynamoDBItemSize } from "./dynamodb-item-size";
import { createDynamoDBPersistEvent } from "./dynamodb-persist-event";
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

test("the persist function reuses validated settings and rejects invalid inputs without SDK IO", async () => {
  const client = new DynamoDBClient({ region: "us-west-1" });
  const send = jest.spyOn(client, "send");
  const serialize = jest.fn().mockReturnValue(new Uint8Array());
  const settings = validateDynamoDBEventStoreInput({
    client,
    tables: { journal: "j", snapshot: "s", head: "h" },
    snapshotAidIndexName: "history",
    eventSerializer: { serialize, deserialize: jest.fn() },
  });
  try {
    if (settings.type !== "ok") throw new Error("valid settings expected");
    const persist = createDynamoDBPersistEvent(settings.value);
    expect(await persist(event(0))).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "W-6" },
    });
    expect(send).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
    client.destroy();
  }
});

describe("persistEvent from the configured internal entry with DynamoDB Local 3.3.1", () => {
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
            : value instanceof Error
              ? { ...value, name: value.name, message: value.message }
              : value,
        2,
      ),
    );
  });

  async function scenario(serializer?: PayloadSerializer<unknown>) {
    const layout = await local.createTables();
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client);
    observations = [...observations, observation];
    const opened = await initializeDynamoDBEventStoreInternal({
      ...layout,
      client,
      eventSerializer: serializer,
    });
    evidence = { ...evidence, layout, opened };
    if (opened.type !== "ok")
      throw new Error("configuration initialization failed");
    const initializationRequests = observation.snapshot().observations.length;
    return {
      ...layout,
      client,
      store: opened.value,
      observation,
      initializationRequests,
    };
  }

  async function readItems(
    tables: { journal: string; snapshot: string; head: string },
    aid = "Order-a-b",
    seqs = [1, 2, 3],
  ) {
    const journal = await Promise.all(
      seqs.map((seqNr) =>
        local.observer.send(
          new GetItemCommand({
            TableName: tables.journal,
            Key: { aid: { S: aid }, seq_nr: { N: seqNr.toString() } },
            ConsistentRead: true,
          }),
        ),
      ),
    );
    const head = await local.observer.send(
      new GetItemCommand({
        TableName: tables.head,
        Key: { aid: { S: aid } },
        ConsistentRead: true,
      }),
    );
    const snapshot = await local.observer.send(
      new GetItemCommand({
        TableName: tables.snapshot,
        Key: { aid: { S: aid }, skey: { N: "0" } },
        ConsistentRead: true,
      }),
    );
    const physical = { journal, head, snapshot };
    evidence = { ...evidence, physical };
    return physical;
  }

  function commits(input: Awaited<ReturnType<typeof scenario>>) {
    const recorded = input.observation
      .snapshot()
      .observations.slice(input.initializationRequests);
    expect(
      recorded.every(
        ({ commandName }) => commandName === "TransactWriteItemsCommand",
      ),
    ).toBe(true);
    return recorded;
  }

  test("creates then appends on the same handle with exact journal/head attributes and two actions", async () => {
    const input = await scenario();
    const userString = jest.fn().mockReturnValue("not-the-aid");
    const first = await input.store.persistEvent(
      event(1, {
        aggregateId: { typeName: "Order", value: "a-b", asString: userString },
      }),
    );
    const afterFirst = await readItems(input.tables);
    const second = await input.store.persistEvent(
      event(2, {
        manifest: "イベント/v2",
        payload: { count: 2 },
        occurredAt: new Date(-1),
      }),
    );
    const physical = await readItems(input.tables);
    evidence = { ...evidence, first, second, afterFirst };
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
    expect(afterFirst.journal[0].Item).toEqual({
      aid: { S: "Order-a-b" },
      ...firstFields,
    });
    expect(afterFirst.head.Item).toEqual({
      aid: { S: "Order-a-b" },
      type_name: { S: "Order" },
      seq_nr: { N: "1" },
      events: { L: [{ M: firstFields }] },
    });
    expect(physical.journal[0].Item).toEqual(afterFirst.journal[0].Item);
    expect(physical.journal[1].Item).toEqual({
      aid: { S: "Order-a-b" },
      ...secondFields,
    });
    expect(physical.head.Item).toEqual({
      aid: { S: "Order-a-b" },
      type_name: { S: "Order" },
      seq_nr: { N: "2" },
      events: { L: [{ M: secondFields }] },
    });
    expect(physical.snapshot.Item).toBeUndefined();
    const requests = commits(input);
    expect(requests).toHaveLength(2);
    const create = requests[0].input as TransactWriteItemsCommandInput;
    const update = requests[1].input as TransactWriteItemsCommandInput;
    expect(create.TransactItems).toHaveLength(2);
    expect(create.TransactItems?.[0].Put).toMatchObject({
      TableName: input.tables.journal,
      ConditionExpression: "attribute_not_exists(aid)",
      Item: afterFirst.journal[0].Item,
    });
    expect(create.TransactItems?.[1].Put).toMatchObject({
      TableName: input.tables.head,
      ConditionExpression: "attribute_not_exists(aid)",
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      Item: afterFirst.head.Item,
    });
    expect(update.TransactItems).toHaveLength(2);
    expect(update.TransactItems?.[0].Put?.ConditionExpression).toBe(
      "attribute_not_exists(aid)",
    );
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
    for (const request of requests) {
      const wire = JSON.parse(request.wireBody as string);
      expect(wire.TransactItems).toHaveLength(2);
      expect(wire.TransactItems[0].Put.Item.occurred_at).toEqual(
        (request.input as TransactWriteItemsCommandInput).TransactItems?.[0].Put
          ?.Item?.occurred_at,
      );
      expect(request.upstream).toMatchObject({
        $metadata: { httpStatusCode: 200, attempts: 1 },
      });
    }
    input.observation.assertApplied();
  }, 30_000);

  test.each<[string, object, string]>([
    ["seq zero", { seqNr: 0 }, "W-6"],
    ["seq negative", { seqNr: -1 }, "T-9"],
    ["seq fractional", { seqNr: 1.5 }, "T-9"],
    ["seq unsafe", { seqNr: 2 ** 53 }, "T-9"],
    [
      "invalid type name",
      { aggregateId: { typeName: "Order-Item", value: "1" } },
      "T-11",
    ],
    [
      "long UTF-8 aid",
      { aggregateId: { typeName: "Order", value: "あ".repeat(340) } },
      "T-12",
    ],
    ["invalid Date", { occurredAt: new Date(Number.NaN) }, "T-13"],
    ["out of range Date", { occurredAt: new Date("2263-01-01") }, "T-13"],
    ["aggregate missing", { aggregateId: undefined }, "T-2"],
    ["seq missing", { seqNr: undefined }, "T-2"],
    ["Date missing", { occurredAt: undefined }, "T-2"],
    ["payload missing", { payload: undefined }, "T-2"],
  ])(
    "rejects %s at the entry before serialize or send",
    async (_name, overrides, rule) => {
      const serialize = jest.fn().mockReturnValue(new Uint8Array());
      const input = await scenario({ serialize, deserialize: jest.fn() });
      const result = await input.store.persistEvent(event(1, overrides));
      const physical = await readItems(input.tables);
      evidence = {
        ...evidence,
        result,
        serializeCalls: serialize.mock.calls.length,
      };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule },
      });
      expect(serialize).not.toHaveBeenCalled();
      expect(commits(input)).toHaveLength(0);
      expect(physical.head.Item).toBeUndefined();
      expect(physical.journal.every(({ Item }) => Item === undefined)).toBe(
        true,
      );
    },
    30_000,
  );

  test("preserves input access failure cause without serialize or send", async () => {
    const cause = new Error("input getter failure");
    const serialize = jest.fn();
    const input = await scenario({ serialize, deserialize: jest.fn() });
    const aggregateId = {
      get typeName(): string {
        throw cause;
      },
      value: "1",
    };
    const result = await input.store.persistEvent(event(1, { aggregateId }));
    await readItems(input.tables);
    evidence = { ...evidence, result, cause };
    expect(result).toMatchObject({
      type: "err",
      error: { type: "contract-violation", rule: "T-2", cause },
    });
    if (result.type !== "err") throw new Error("expected failure");
    expect(result.error.cause).toBe(cause);
    expect(serialize).not.toHaveBeenCalled();
    expect(commits(input)).toHaveLength(0);
  }, 30_000);

  test.each(["throw", "invalid bytes"])(
    "serializer %s fails with cause and sends zero",
    async (mode) => {
      const cause = new Error("serializer failure");
      const serialize = jest.fn(() => {
        if (mode === "throw") throw cause;
        return "invalid" as unknown as Uint8Array;
      });
      const input = await scenario({ serialize, deserialize: jest.fn() });
      const result = await input.store.persistEvent(event());
      const physical = await readItems(input.tables);
      evidence = {
        ...evidence,
        result,
        cause,
        serializeCalls: serialize.mock.calls.length,
      };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "serialization-error", operation: "serialize" },
      });
      if (result.type !== "err") throw new Error("expected failure");
      if (mode === "throw") expect(result.error.cause).toBe(cause);
      else expect(result.error.cause).toBeInstanceOf(TypeError);
      expect(serialize).toHaveBeenCalledWith({ count: 1 });
      expect(commits(input)).toHaveLength(0);
      expect(physical.head.Item).toBeUndefined();
      expect(physical.journal.every(({ Item }) => Item === undefined)).toBe(
        true,
      );
    },
    30_000,
  );

  test.each([1, 2, 4])(
    "real head condition failure for sequence %s keeps both items unchanged",
    async (seqNr) => {
      const input = await scenario();
      expect(await input.store.persistEvent(event())).toMatchObject({
        type: "ok",
      });
      expect(await input.store.persistEvent(event(2))).toMatchObject({
        type: "ok",
      });
      const before = await readItems(input.tables, "Order-a-b", [1, 2, 4]);
      const result = await input.store.persistEvent(
        event(seqNr, { payload: { loser: true } }),
      );
      const after = await readItems(input.tables, "Order-a-b", [1, 2, 4]);
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
      expect(cause).toBeInstanceOf(TransactionCanceledException);
      if (
        !(cause instanceof TransactionCanceledException) ||
        result.type !== "err"
      )
        throw new Error("expected cancellation");
      expect(cause.CancellationReasons?.[1].Code).toBe(
        "ConditionalCheckFailed",
      );
      expect(cause.CancellationReasons?.[1].Item).toEqual(before.head.Item);
      expect(result.error.cause).toBe(cause);
      expect(after.head.Item).toEqual(before.head.Item);
      for (let i = 0; i < before.journal.length; i++)
        expect(after.journal[i].Item).toEqual(before.journal[i].Item);
    },
    30_000,
  );

  test("missing old head is zero and an update is a gap without a classification read", async () => {
    const input = await scenario();
    const result = await input.store.persistEvent(event(2));
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
    expect(cause.CancellationReasons?.[0].Code).toBe("None");
    expect(cause.CancellationReasons?.[1]).toMatchObject({
      Code: "ConditionalCheckFailed",
    });
    expect(cause.CancellationReasons?.[1].Item).toBeUndefined();
    expect(result.error.cause).toBe(cause);
    expect(physical.head.Item).toBeUndefined();
    expect(physical.journal[1].Item).toBeUndefined();
  }, 30_000);

  test("a real journal condition failure rolls back an otherwise valid head update", async () => {
    const input = await scenario();
    expect(await input.store.persistEvent(event())).toMatchObject({
      type: "ok",
    });
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
    const result = await input.store.persistEvent(event(2));
    const after = await readItems(input.tables);
    evidence = { ...evidence, before, result, after };
    expect(result).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict", seqNr: 2 },
    });
    const cause = commits(input)[1].error;
    if (
      !(cause instanceof TransactionCanceledException) ||
      result.type !== "err"
    )
      throw new Error("expected cancellation");
    expect(cause.CancellationReasons?.map(({ Code }) => Code)).toEqual([
      "ConditionalCheckFailed",
      "None",
    ]);
    expect(result.error.cause).toBe(cause);
    expect(after.journal[1].Item).toEqual(seeded);
    expect(after.head.Item).toEqual(before.head.Item);
  }, 30_000);

  test.each(["payload", "manifest"])(
    "%s item upper bound rejects before send",
    async (kind) => {
      const serialize = jest.fn(
        () => new Uint8Array(kind === "manifest" ? 0 : 409600),
      );
      const input = await scenario({ serialize, deserialize: jest.fn() });
      const manifest = kind === "manifest" ? "あ".repeat(136_534) : "";
      const result = await input.store.persistEvent(event(1, { manifest }));
      const physical = await readItems(input.tables);
      evidence = {
        ...evidence,
        result,
        manifestBytes: Buffer.byteLength(manifest),
      };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule: "D-7", seqNr: 1 },
      });
      expect(commits(input)).toHaveLength(0);
      expect(physical.head.Item).toBeUndefined();
      expect(physical.journal[0].Item).toBeUndefined();
    },
    30_000,
  );

  test.each([1, 2])(
    "head-only overhead excess is rejected for sequence %s at 409601",
    async (seqNr) => {
      const input = await scenario();
      if (seqNr === 2)
        expect(await input.store.persistEvent(event())).toMatchObject({
          type: "ok",
        });
      // この属性集合の上界はjournalがpayload+73、headがpayload+117。
      const serializer = {
        serialize: () => new Uint8Array(409600 - 117 + 1),
        deserialize: jest.fn(),
      };
      const opened = await initializeDynamoDBEventStoreInternal({
        ...input,
        eventSerializer: serializer,
      });
      if (opened.type !== "ok")
        throw new Error("expected reopened configuration");
      const offset = input.observation.snapshot().observations.length;
      const before = await readItems(input.tables);
      const result = await opened.value.persistEvent(event(seqNr));
      const after = await readItems(input.tables);
      evidence = {
        ...evidence,
        before,
        result,
        after,
        payloadBytes: 409600 - 117 + 1,
      };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule: "D-7" },
      });
      expect(input.observation.snapshot().observations).toHaveLength(offset);
      expect(after.head.Item).toEqual(before.head.Item);
      expect(after.journal[seqNr - 1].Item).toBeUndefined();
    },
    30_000,
  );

  test("the exact 409600 upper bound remains writable", async () => {
    const input = await scenario({
      serialize: () => new Uint8Array(409600 - 117),
      deserialize: jest.fn(),
    });
    const result = await input.store.persistEvent(event());
    const physical = await readItems(input.tables);
    evidence = { ...evidence, result };
    expect(result).toMatchObject({ type: "ok" });
    expect(physical.head.Item?.events?.L?.[0].M?.payload?.B?.byteLength).toBe(
      409600 - 117,
    );
    const request = commits(input)[0].input as TransactWriteItemsCommandInput;
    expect(
      dynamoDBItemSize(
        request.TransactItems?.[1].Put?.Item as Record<string, AttributeValue>,
      ),
    ).toBe(409600);
    expect(
      dynamoDBItemSize(
        request.TransactItems?.[0].Put?.Item as Record<string, AttributeValue>,
      ),
    ).toBe(409556);
  }, 30_000);

  test("arbitrary domain serializer and mutable input/Buffer stay independent before SDK serialization", async () => {
    class DomainEvent {
      constructor(private readonly amount: bigint) {}
      encode(): string {
        return `amount:${this.amount}`;
      }
    }
    const payload = new DomainEvent(BigInt(7));
    const backing = Buffer.from("--amount:7--");
    const returned = backing.subarray(2, 10);
    const raw = { ...event(1, { payload, manifest: "domain/1" }) };
    const serialize = jest.fn((value: unknown) => {
      if (!(value instanceof DomainEvent))
        throw new TypeError("domain expected");
      raw.aggregateId = { typeName: "Other", value: "changed" };
      raw.seqNr = 99;
      raw.manifest = "changed";
      raw.occurredAt.setTime(0);
      expect(value.encode()).toBe("amount:7");
      return returned;
    });
    const deserialize = jest.fn();
    const input = await scenario({ serialize, deserialize });
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
      const pending = input.store.persistEvent(raw);
      await ready.promise;
      returned.fill(0);
      raw.payload = null;
      release.resolve();
      const result = await pending;
      const physical = await readItems(input.tables);
      evidence = {
        ...evidence,
        result,
        changedBytes: returned,
        serializeCalls: serialize.mock.calls.length,
      };
      expect(result).toMatchObject({ type: "ok" });
      expect(serialize).toHaveBeenCalledWith(payload);
      expect(deserialize).not.toHaveBeenCalled();
      const fields = {
        seq_nr: { N: "1" },
        occurred_at: { N: "1735787045678000000" },
        manifest: { S: "domain/1" },
        payload: { B: Buffer.from("amount:7") },
      };
      expect(physical.journal[0].Item).toEqual({
        aid: { S: "Order-a-b" },
        ...fields,
      });
      expect(physical.head.Item).toEqual({
        aid: { S: "Order-a-b" },
        type_name: { S: "Order" },
        seq_nr: { N: "1" },
        events: { L: [{ M: fields }] },
      });
      expect(commits(input)).toHaveLength(1);
    } finally {
      release.resolve();
      send.mockRestore();
    }
  }, 30_000);

  test("two independent writers produce one real winner and no partial losing commit", async () => {
    const input = await scenario();
    expect(await input.store.persistEvent(event())).toMatchObject({
      type: "ok",
    });
    const secondClient = local.createClient();
    const opened = await initializeDynamoDBEventStoreInternal({
      ...input,
      client: secondClient,
    });
    if (opened.type !== "ok") throw new Error("expected second writer");
    let arrivals = 0;
    const ready = Promise.withResolvers<void>();
    const gate = async () => {
      arrivals += 1;
      if (arrivals === 2) ready.resolve();
      await ready.promise;
    };
    // 同じclientに観測を二重登録せず、firstの実要求をbuild段階で同期する。
    input.client.middlewareStack.add(
      (next) => async (args) => {
        await gate();
        return next(args);
      },
      { step: "build", name: "writerRendezvous" },
    );
    const secondObservation = new DynamoDBPersistEventObservation(
      secondClient,
      gate,
    );
    observations = [...observations, secondObservation];
    const results = await Promise.all([
      input.store.persistEvent(event(2, { payload: { writer: "first" } })),
      opened.value.persistEvent(event(2, { payload: { writer: "second" } })),
    ]);
    const physical = await readItems(input.tables);
    evidence = { ...evidence, results, arrivals };
    expect(arrivals).toBe(2);
    expect(results.filter(({ type }) => type === "ok")).toHaveLength(1);
    expect(results.filter(({ type }) => type === "err")).toHaveLength(1);
    const winnerIndex = results.findIndex(({ type }) => type === "ok");
    const loser = results[1 - winnerIndex];
    const cause =
      winnerIndex === 0
        ? secondObservation.snapshot().observations[0].error
        : commits(input)[1].error;
    expect(loser).toMatchObject({
      type: "err",
      error: { type: "optimistic-lock-conflict" },
    });
    if (loser.type !== "err") throw new Error("expected losing result");
    expect(cause).toBeInstanceOf(TransactionCanceledException);
    expect(loser.error.cause).toBe(cause);
    expect(physical.journal[1].Item?.payload).toEqual({
      B: Buffer.from(
        JSON.stringify({ writer: winnerIndex === 0 ? "first" : "second" }),
      ),
    });
    expect(physical.head.Item?.seq_nr).toEqual({ N: "2" });
    expect(physical.head.Item?.events?.L?.[0].M?.payload).toEqual(
      physical.journal[1].Item?.payload,
    );
    expect(physical.journal[2].Item).toBeUndefined();
    expect(commits(input)).toHaveLength(2);
    expect(secondObservation.snapshot().observations).toHaveLength(1);
    input.observation.assertApplied();
    secondObservation.assertApplied();
  }, 30_000);

  test.each<[string, CancellationReason[], string]>([
    [
      "conflict over head gap",
      [
        { Code: "TransactionConflict" },
        { Code: "ConditionalCheckFailed", Item: { seq_nr: { N: "1" } } },
      ],
      "optimistic-lock-conflict",
    ],
    [
      "head gap over journal condition",
      [
        { Code: "ConditionalCheckFailed" },
        { Code: "ConditionalCheckFailed", Item: { seq_nr: { N: "1" } } },
      ],
      "contract-violation",
    ],
    [
      "other cancellation",
      [{ Code: "None" }, { Code: "ThrottlingError" }],
      "storage-error",
    ],
  ])(
    "recorded replace-request %s preserves cause, application and no effects",
    async (_name, CancellationReasons, type) => {
      const input = await scenario();
      const cause = new TransactionCanceledException({
        $metadata: {},
        message: "sdk-private-diagnostic",
        CancellationReasons,
      });
      input.observation.failNext(cause);
      const result = await input.store.persistEvent(event(4));
      const physical = await readItems(input.tables, "Order-a-b", [4]);
      evidence = { ...evidence, result, cause };
      expect(result).toMatchObject({ type: "err", error: { type } });
      if (result.type !== "err") throw new Error("expected failure");
      expect(result.error.cause).toBe(cause);
      expect(result.error.message).not.toContain(cause.message);
      expect(physical.journal[0].Item).toBeUndefined();
      expect(physical.head.Item).toBeUndefined();
      expect(commits(input)).toHaveLength(1);
      expect(commits(input)[0].upstream).toBeUndefined();
      input.observation.assertApplied();
      expect(input.observation.snapshot().unapplied).toEqual([]);
    },
    30_000,
  );

  test("a registered commit fault is explicitly unapplied when input validation stops the send", async () => {
    const input = await scenario();
    input.observation.failNext(new Error("planned but unused"));
    const result = await input.store.persistEvent(event(0));
    await readItems(input.tables);
    evidence = { ...evidence, result };
    expect(commits(input)).toHaveLength(0);
    expect(input.observation.snapshot().unapplied).toEqual([0]);
    expect(() => input.observation.assertApplied()).toThrow("not applied");
  }, 30_000);
});
