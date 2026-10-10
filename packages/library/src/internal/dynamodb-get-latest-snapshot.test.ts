import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttributeValue,
  type BatchGetItemCommand,
  type BatchGetItemCommandInput,
  type BatchGetItemCommandOutput,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import type { AggregateId } from "../aggregate-id";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import type { EventEnvelope } from "../event-envelope";
import { PayloadSerializer } from "../payload-serializer";
import { initializeDynamoDBEventStoreInternal } from "./dynamodb-event-store";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { createDynamoDBGetLatestSnapshot } from "./dynamodb-get-latest-snapshot";
import { DynamoDBLocal } from "./test/dynamodb-local";
import { DynamoDBPersistEventObservation } from "./test/dynamodb-persist-event-observation";
import { deferDynamoDBRequestedKeys } from "./test/dynamodb-unprocessed-keys";

const id = Object.freeze({ typeName: "Order", value: "a-b" });
const time = new Date("2025-01-02T03:04:05.678Z");
function event(seqNr: number, aggregateId: AggregateId = id): EventEnvelope {
  return {
    aggregateId,
    seqNr,
    occurredAt: time,
    manifest: "event/v1",
    payload: { count: seqNr },
  };
}

test("latest read uses the shared default wait before a retry with an SDK send spy", async () => {
  jest.useFakeTimers();
  const client = new DynamoDBClient({
    region: "us-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const send = jest
    .spyOn(
      client as {
        send(command: BatchGetItemCommand): Promise<BatchGetItemCommandOutput>;
      },
      "send",
    )
    .mockResolvedValue({
      $metadata: {},
      UnprocessedKeys: { head: { Keys: [{ aid: { S: "Order-a-b" } }] } },
    });
  try {
    const settings = validateDynamoDBEventStoreInput({
      client,
      tables: { journal: "journal", head: "head", snapshot: "snapshot" },
      snapshotAidIndexName: "history",
      retryLimit: 1,
    });
    if (settings.type !== "ok") throw new Error("expected settings");
    const result = createDynamoDBGetLatestSnapshot(settings.value)(id);
    await jest.advanceTimersByTimeAsync(49);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    send.mockRestore();
    client.destroy();
    jest.useRealTimers();
  }
});

describe("getLatestSnapshotById through the configured internal entry with DynamoDB Local 3.3.1", () => {
  let local: DynamoDBLocal;
  let evidence: Record<string, unknown>;
  let observers: DynamoDBPersistEventObservation[];
  beforeAll(async () => {
    local = await DynamoDBLocal.start();
  }, 120_000);
  afterAll(async () => {
    if (local !== undefined) await local.stop();
  }, 120_000);
  beforeEach(() => {
    evidence = {};
    observers = [];
  });
  afterEach(async () => {
    for (const observation of observers) observation.assertApplied();
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
          observations: observers.map((o) => o.snapshot()),
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
                : typeof value === "bigint"
                  ? value.toString()
                  : value,
        2,
      ),
    );
  });

  async function scenario(
    options: Partial<
      Omit<
        DynamoDBEventStoreInput<unknown, unknown>,
        "client" | "tables" | "snapshotAidIndexName"
      >
    > = {},
    layout?: Awaited<ReturnType<DynamoDBLocal["createTables"]>>,
    sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined),
  ) {
    const selected = layout ?? (await local.createTables());
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client);
    observers = [...observers, observation];
    const json = PayloadSerializer.json();
    const eventSerializer = options.eventSerializer ?? json;
    const snapshotSerializer = options.snapshotSerializer ?? json;
    const eventSerialize = jest.fn(eventSerializer.serialize);
    const eventDeserialize = jest.fn(eventSerializer.deserialize);
    const snapshotSerialize = jest.fn(snapshotSerializer.serialize);
    const snapshotDeserialize = jest.fn(snapshotSerializer.deserialize);
    const opened = await initializeDynamoDBEventStoreInternal(
      {
        ...selected,
        ...options,
        client,
        eventSerializer: {
          serialize: eventSerialize,
          deserialize: eventDeserialize,
        },
        snapshotSerializer: {
          serialize: snapshotSerialize,
          deserialize: snapshotDeserialize,
        },
      },
      { sleep },
    );
    if (opened.type !== "ok") throw new Error("expected configured store");
    expect(opened.value.settings.client).toBe(client);
    evidence = {
      ...evidence,
      layouts: [...((evidence.layouts as unknown[]) ?? []), selected],
      configurations: [
        ...((evidence.configurations as unknown[]) ?? []),
        opened.value.configuration,
      ],
    };
    return {
      ...selected,
      client,
      observation,
      store: opened.value,
      sleep,
      eventSerialize,
      eventDeserialize,
      snapshotSerialize,
      snapshotDeserialize,
      operation: 0,
    };
  }

  async function read(
    input: Awaited<ReturnType<typeof scenario>>,
    aggregateId: AggregateId = id,
    beforeSend?: () => Promise<void>,
  ) {
    input.operation += 1;
    input.observation.beginReadSnapshot(
      input.tables,
      input.operation,
      beforeSend,
    );
    const result = await input.store.getLatestSnapshotById(aggregateId);
    evidence = {
      ...evidence,
      reads: [
        ...((evidence.reads as unknown[]) ?? []),
        { operation: input.operation, result },
      ],
    };
    return result;
  }

  function batches(
    input: Awaited<ReturnType<typeof scenario>>,
    operation = input.operation,
  ) {
    return input.observation
      .snapshot()
      .observations.filter((o) => o.readSnapshot?.operation === operation);
  }

  async function physical(
    input: Awaited<ReturnType<typeof scenario>>,
    aggregateId: AggregateId = id,
  ) {
    const aid = `${aggregateId.typeName}-${aggregateId.value}`;
    const [journal, head, snapshot] = await Promise.all([
      local.observer.send(
        new GetItemCommand({
          TableName: input.tables.journal,
          Key: { aid: { S: aid }, seq_nr: { N: "1" } },
          ConsistentRead: true,
        }),
      ),
      local.observer.send(
        new GetItemCommand({
          TableName: input.tables.head,
          Key: { aid: { S: aid } },
          ConsistentRead: true,
        }),
      ),
      local.observer.send(
        new GetItemCommand({
          TableName: input.tables.snapshot,
          Key: { aid: { S: aid }, skey: { N: "0" } },
          ConsistentRead: true,
        }),
      ),
    ]);
    const saved = {
      journal: journal.Item,
      head: head.Item,
      snapshot: snapshot.Item,
    };
    evidence = {
      ...evidence,
      physical: [
        ...((evidence.physical as unknown[]) ?? []),
        { aid, tables: input.tables, saved },
      ],
    };
    return saved;
  }

  async function pair(
    input: Awaited<ReturnType<typeof scenario>>,
    seqNr = 1,
    aggregate: unknown = { count: seqNr },
    aggregateId: AggregateId = id,
  ) {
    const snapshot = { seqNr, manifest: "snapshot/v2", aggregate };
    const result = await input.store.persistEventAndSnapshot(
      event(seqNr, aggregateId),
      snapshot,
    );
    expect(result).toEqual({ type: "ok", value: undefined });
    evidence = {
      ...evidence,
      writes: [
        ...((evidence.writes as unknown[]) ?? []),
        { event: event(seqNr, aggregateId), snapshot, result },
      ],
    };
    return snapshot;
  }

  function defer(
    input: Awaited<ReturnType<typeof scenario>>,
    tables: readonly string[],
    count: number,
  ) {
    for (let request = 1; request <= count; request += 1) {
      input.observation.replaceReadSnapshot({
        operation: input.operation + 1,
        table: tables[0],
        request,
        replace: (output, actual) =>
          deferDynamoDBRequestedKeys(actual, output, tables),
      });
    }
  }

  test("the same configured store observes absent, head-only, pair and event-only states", async () => {
    const input = await scenario();
    expect(await read(input)).toEqual({ type: "ok", value: undefined });
    await physical(input);
    expect(await input.store.persistEvent(event(1))).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(await read(input)).toEqual({ type: "ok", value: { headSeqNr: 1 } });
    const afterEvent = await physical(input);
    expect(afterEvent.head?.seq_nr).toEqual({ N: "1" });
    expect(afterEvent.snapshot).toBeUndefined();
    const snapshot = await pair(input, 2);
    const first = await read(input);
    expect(first).toEqual({ type: "ok", value: { headSeqNr: 2, snapshot } });
    const afterPair = await physical(input);
    expect(afterPair.snapshot).toMatchObject({
      aid: { S: "Order-a-b" },
      skey: { N: "0" },
      seq_nr: { N: "2" },
      last_updated_at: { N: time.getTime().toString() },
      manifest: { S: "snapshot/v2" },
    });
    expect(await input.store.persistEvent(event(3))).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(await read(input)).toEqual({
      type: "ok",
      value: { headSeqNr: 3, snapshot },
    });
    const afterAppend = await physical(input);
    expect(afterAppend.head?.seq_nr).toEqual({ N: "3" });
    expect(afterAppend.snapshot).toEqual(afterPair.snapshot);
    expect(first).toEqual({ type: "ok", value: { headSeqNr: 2, snapshot } });
    expect(input.eventDeserialize).not.toHaveBeenCalled();
    expect(input.snapshotDeserialize).toHaveBeenCalledTimes(2);
    for (const operation of [1, 2, 3, 4]) {
      const requests = batches(input, operation);
      expect(requests).toHaveLength(1);
      const expected = {
        RequestItems: {
          [input.tables.head]: {
            Keys: [{ aid: { S: "Order-a-b" } }],
            ConsistentRead: true,
          },
          [input.tables.snapshot]: {
            Keys: [{ aid: { S: "Order-a-b" }, skey: { N: "0" } }],
            ConsistentRead: true,
          },
        },
      };
      expect(requests[0].input).toEqual(expected);
      expect(JSON.parse(requests[0].wireBody as string)).toEqual(expected);
      expect(requests[0].commandName).toBe("BatchGetItemCommand");
    }
    expect(
      input.observation
        .snapshot()
        .observations.every(
          ({ commandName }) =>
            commandName === "BatchGetItemCommand" ||
            commandName === "TransactWriteItemsCommand",
        ),
    ).toBe(true);
  }, 30_000);

  test("a snapshot without a head remains absent and does not deserialize", async () => {
    const input = await scenario();
    await pair(input);
    await local.observer.send(
      new DeleteItemCommand({
        TableName: input.tables.head,
        Key: { aid: { S: "Order-a-b" } },
      }),
    );
    const saved = await physical(input);
    expect(saved.snapshot).toBeDefined();
    expect(saved.head).toBeUndefined();
    expect(await read(input)).toEqual({ type: "ok", value: undefined });
    expect(input.snapshotDeserialize).not.toHaveBeenCalled();
  }, 30_000);

  test("separate Clients share one destination and independent three-table stores remain isolated", async () => {
    const first = await scenario();
    const shared = await scenario({}, first);
    const isolated = await scenario();
    const snapshot = await pair(first, 1, "shared");
    expect(await read(shared)).toEqual({
      type: "ok",
      value: { headSeqNr: 1, snapshot },
    });
    expect(await read(isolated)).toEqual({ type: "ok", value: undefined });
    const separate = await pair(isolated, 1, "isolated");
    expect(await read(isolated)).toEqual({
      type: "ok",
      value: { headSeqNr: 1, snapshot: separate },
    });
    expect(await shared.store.persistEvent(event(2))).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(await read(first)).toEqual({
      type: "ok",
      value: { headSeqNr: 2, snapshot },
    });
    await physical(first);
    await physical(isolated);
  }, 30_000);

  test.each(["all", "head", "snapshot"] as const)(
    "accumulates actual responses while retrying only %s unprocessed keys",
    async (selection) => {
      const input = await scenario();
      const snapshot = await pair(input);
      const targets =
        selection === "all"
          ? [input.tables.head, input.tables.snapshot]
          : [input.tables[selection]];
      defer(input, targets, 1);
      expect(await read(input)).toEqual({
        type: "ok",
        value: { headSeqNr: 1, snapshot },
      });
      const requests = batches(input);
      expect(requests).toHaveLength(2);
      const upstream = requests[0].upstream as BatchGetItemCommandOutput;
      expect(upstream.Responses?.[input.tables.head]).toHaveLength(1);
      expect(upstream.Responses?.[input.tables.snapshot]).toHaveLength(1);
      const pending = (requests[0].returned as BatchGetItemCommandOutput)
        .UnprocessedKeys;
      expect(Object.keys(pending ?? {}).sort()).toEqual([...targets].sort());
      expect(
        (requests[1].input as BatchGetItemCommandInput).RequestItems,
      ).toEqual(
        Object.fromEntries(
          Object.entries(pending ?? {}).map(([table, keys]) => [
            table,
            { ...keys, ConsistentRead: true },
          ]),
        ),
      );
      expect(input.sleep.mock.calls).toEqual([[50]]);
      expect(input.snapshotDeserialize).toHaveBeenCalledTimes(1);
      await physical(input);
    },
    30_000,
  );

  test.each([0, 1, undefined, 7])(
    "retryLimit %p excludes the first request and exhausts without partial success",
    async (retryLimit) => {
      const input = await scenario({ retryLimit });
      await pair(input);
      const count = (retryLimit ?? 5) + 1;
      defer(input, [input.tables.snapshot], count);
      const result = await read(input);
      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      if (result.type !== "err") throw new Error("expected exhaustion");
      const requests = batches(input);
      expect(requests).toHaveLength(count);
      expect(result.error.cause).toEqual(requests[count - 1].returned);
      expect(input.sleep.mock.calls).toEqual(
        [50, 100, 200, 400, 800, 1000, 1000]
          .slice(0, count - 1)
          .map((delay) => [delay]),
      );
      expect(input.snapshotDeserialize).not.toHaveBeenCalled();
      expect(input.eventDeserialize).not.toHaveBeenCalled();
    },
    30_000,
  );

  test("unprocessed absent keys stay unresolved until the retry completes", async () => {
    const input = await scenario();
    defer(input, [input.tables.head, input.tables.snapshot], 1);
    expect(await read(input)).toEqual({ type: "ok", value: undefined });
    expect(batches(input)).toHaveLength(2);
    expect(input.sleep.mock.calls).toEqual([[50]]);
    await physical(input);
  }, 30_000);

  test("wait release fixes aid and prevents the next SDK request until released", async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sleep = jest.fn(async (_ms: number) => {
      waiting.resolve();
      await release.promise;
    });
    const input = await scenario({}, undefined, sleep);
    const snapshot = await pair(input);
    const typeName = jest
      .fn()
      .mockReturnValueOnce("Order")
      .mockImplementation(() => {
        throw new Error("typeName read twice");
      });
    const value = jest
      .fn()
      .mockReturnValueOnce("a-b")
      .mockImplementation(() => {
        throw new Error("value read twice");
      });
    const supplied = Object.defineProperties(
      {},
      {
        typeName: { get: typeName, configurable: true },
        value: { get: value, configurable: true },
      },
    ) as AggregateId;
    defer(input, [input.tables.head, input.tables.snapshot], 1);
    const reading = read(input, supplied);
    await waiting.promise;
    try {
      expect(batches(input)).toHaveLength(1);
      expect(input.snapshotDeserialize).not.toHaveBeenCalled();
      Object.defineProperties(supplied, {
        typeName: { value: "Changed" },
        value: { value: "changed" },
      });
    } finally {
      release.resolve();
    }
    expect(await reading).toEqual({
      type: "ok",
      value: { headSeqNr: 1, snapshot },
    });
    expect(typeName).toHaveBeenCalledTimes(1);
    expect(value).toHaveBeenCalledTimes(1);
    for (const request of batches(input))
      for (const table of Object.values(
        (request.input as BatchGetItemCommandInput).RequestItems ?? {},
      ))
        expect(table.Keys?.[0].aid).toEqual({ S: "Order-a-b" });
    evidence = {
      ...evidence,
      getterCalls: {
        typeName: typeName.mock.calls.length,
        value: value.mock.calls.length,
      },
      waits: sleep.mock.calls,
    };
  }, 30_000);

  test.each<[unknown, string]>([
    [undefined, "T-2"],
    [null, "T-2"],
    [{ typeName: 1, value: "b" }, "T-2"],
    [{ typeName: "Order", value: null }, "T-2"],
    [{ typeName: "Order-Item", value: "b" }, "T-11"],
    [{ typeName: "Order", value: "界".repeat(340) }, "T-12"],
  ])(
    "invalid ID %# returns the common Result before requests, writes or restoration",
    async (invalid, rule) => {
      const input = await scenario();
      const before = input.observation.snapshot().observations.length;
      const result = await input.store.getLatestSnapshotById(
        invalid as AggregateId,
      );
      evidence = { ...evidence, invalidId: invalid, result };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule },
      });
      expect(input.observation.snapshot().observations).toHaveLength(before);
      for (const call of [
        input.eventSerialize,
        input.eventDeserialize,
        input.snapshotSerialize,
        input.snapshotDeserialize,
      ])
        expect(call).not.toHaveBeenCalled();
      await physical(input);
    },
    30_000,
  );

  test.each(["getter", "proxy"])(
    "%s access failure preserves cause before SDK or serializer calls",
    async (kind) => {
      const input = await scenario();
      const cause = new Error("id access failed");
      const get = jest.fn(() => {
        throw cause;
      });
      const supplied =
        kind === "getter"
          ? Object.defineProperty({ value: "a-b" }, "typeName", { get })
          : new Proxy(id, { get });
      const before = input.observation.snapshot().observations.length;
      const result = await read(input, supplied as AggregateId);
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule: "T-2" },
      });
      if (result.type !== "err") throw new Error("expected ID failure");
      expect(result.error.cause).toBe(cause);
      expect(get).toHaveBeenCalledTimes(1);
      expect(input.observation.snapshot().observations).toHaveLength(before);
      for (const call of [
        input.eventSerialize,
        input.eventDeserialize,
        input.snapshotSerialize,
        input.snapshotDeserialize,
      ])
        expect(call).not.toHaveBeenCalled();
    },
    30_000,
  );

  test.each([
    { typeName: "Ord", value: "界".repeat(340) },
    { typeName: "", value: "" },
  ])(
    "accepts common UTF-8 boundaries and ignores user stringification %#",
    async (aggregateId) => {
      const input = await scenario();
      const asString = jest.fn(() => {
        throw new Error("user stringification called");
      });
      const snapshot = await pair(input, 1, { count: 1 }, aggregateId);
      expect(
        await read(input, { ...aggregateId, asString } as AggregateId),
      ).toEqual({ type: "ok", value: { headSeqNr: 1, snapshot } });
      expect(asString).not.toHaveBeenCalled();
      await physical(input, aggregateId);
    },
    30_000,
  );

  test("SDK failure during a retry preserves its cause and publishes no accumulated head", async () => {
    const input = await scenario();
    await pair(input);
    defer(input, [input.tables.snapshot], 1);
    const cause = new Error("retry SDK failure");
    input.observation.failReadSnapshot({
      operation: 1,
      table: input.tables.snapshot,
      request: 2,
      cause,
    });
    const result = await read(input);
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected retry failure");
    expect(result.error.cause).toBe(cause);
    const requests = batches(input);
    expect(requests).toHaveLength(2);
    expect(
      (requests[0].returned as BatchGetItemCommandOutput).Responses?.[
        input.tables.head
      ],
    ).toHaveLength(1);
    expect(requests[1].upstream).toBeUndefined();
    expect(requests[1].error).toBe(cause);
    expect(input.snapshotDeserialize).not.toHaveBeenCalled();
    await physical(input);
  }, 30_000);

  test("an actual SDK missing-table failure preserves the original SDK cause", async () => {
    const input = await scenario();
    await pair(input);
    const tables = {
      ...input.tables,
      snapshot: `${input.tables.snapshot}-missing`,
    };
    const latest = createDynamoDBGetLatestSnapshot({
      ...input.store.settings,
      tables,
    });
    input.observation.beginReadSnapshot(tables, 1);
    const result = await latest(id);
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected SDK failure");
    const request = batches(input, 1)[0];
    expect(request.error).toBeInstanceOf(ResourceNotFoundException);
    expect(result.error.cause).toBe(request.error);
    expect(request.upstream).toBeUndefined();
    expect(input.snapshotDeserialize).not.toHaveBeenCalled();
    evidence = { ...evidence, sdkFailureTables: tables, result };
  }, 30_000);

  test("dedicated snapshot deserialization preserves its failure cause", async () => {
    const cause = new Error("snapshot deserialize failed");
    const input = await scenario({
      snapshotSerializer: {
        serialize: PayloadSerializer.json().serialize,
        deserialize() {
          throw cause;
        },
      },
    });
    await pair(input);
    const result = await read(input);
    expect(result).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "deserialize" },
    });
    if (result.type !== "err") throw new Error("expected deserialize failure");
    expect(result.error.cause).toBe(cause);
    expect(input.snapshotDeserialize).toHaveBeenCalledTimes(1);
    expect(input.eventDeserialize).not.toHaveBeenCalled();
    await physical(input);
  }, 30_000);

  test("arbitrary domain restoration retains stored envelope metadata and opaque manifest", async () => {
    const domain = {
      seqNr: 99,
      manifest: "domain",
      map: new Map([["value", Symbol("opaque")]]),
      callback: () => BigInt(1),
    };
    const deserialize = jest.fn(() => domain);
    const input = await scenario({
      snapshotSerializer: {
        serialize: () => new Uint8Array([1, 2, 3]),
        deserialize,
      },
    });
    await pair(input, 1, domain);
    const result = await read(input);
    if (result.type !== "ok" || result.value?.snapshot === undefined)
      throw new Error("expected domain snapshot");
    expect(result.value.snapshot.aggregate).toBe(domain);
    expect(result.value.snapshot.seqNr).toBe(1);
    expect(result.value.snapshot.manifest).toBe("snapshot/v2");
    expect(Object.isFrozen(domain)).toBe(false);
    expect(deserialize).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "snapshot/v2",
    );
    await physical(input);
  }, 30_000);

  test("deserializer and returned bytes mutations do not reach SDK bytes, storage or later reads", async () => {
    const input = await scenario({
      snapshotSerializer: {
        serialize: (value) => value as Uint8Array,
        deserialize: (bytes) => {
          bytes[0] = 9;
          return bytes;
        },
      },
    });
    const original = new Uint8Array([1, 2, 3]);
    await pair(input, 1, original);
    const before = await physical(input);
    let sdkBytes: Uint8Array | undefined;
    input.observation.replaceReadSnapshot({
      operation: 1,
      table: input.tables.snapshot,
      request: 1,
      replace: (output) => {
        sdkBytes = output.Responses?.[input.tables.snapshot]?.[0].payload.B;
        return output;
      },
    });
    const first = await read(input);
    if (first.type !== "ok" || first.value?.snapshot === undefined)
      throw new Error("expected bytes");
    const returned = first.value.snapshot.aggregate as Uint8Array;
    expect(returned).toEqual(new Uint8Array([9, 2, 3]));
    returned.fill(0);
    original.fill(8);
    expect(sdkBytes).toEqual(new Uint8Array([1, 2, 3]));
    const after = await physical(input);
    expect(after).toEqual(before);
    const second = await read(input);
    expect(second).toMatchObject({
      type: "ok",
      value: { snapshot: { aggregate: new Uint8Array([9, 2, 3]) } },
    });
    evidence = {
      ...evidence,
      sdkBytes,
      returnedAfterMutation: returned,
      originalAfterMutation: original,
    };
  }, 30_000);

  test("R-8 delivers actual old head and actual new snapshot, then permits further writes and reads", async () => {
    const reader = await scenario();
    const writer = await scenario({}, reader);
    await pair(reader);
    let oldHead: Record<string, AttributeValue> | undefined;
    let interleaved = 0;
    reader.observation.replaceReadSnapshot({
      operation: 1,
      table: reader.tables.head,
      request: 1,
      replace: (output) => {
        if (oldHead === undefined) throw new Error("old head was not captured");
        return {
          ...output,
          Responses: { ...output.Responses, [reader.tables.head]: [oldHead] },
        };
      },
    });
    const mixed = await read(reader, id, async () => {
      oldHead = (await physical(reader)).head;
      await pair(writer, 2);
      interleaved += 1;
    });
    expect(mixed).toEqual({
      type: "ok",
      value: {
        headSeqNr: 1,
        snapshot: {
          seqNr: 2,
          manifest: "snapshot/v2",
          aggregate: { count: 2 },
        },
      },
    });
    const request = batches(reader)[0];
    expect(
      (request.upstream as BatchGetItemCommandOutput).Responses?.[
        reader.tables.head
      ]?.[0].seq_nr,
    ).toEqual({ N: "2" });
    expect(
      (request.returned as BatchGetItemCommandOutput).Responses?.[
        reader.tables.head
      ]?.[0],
    ).toEqual(oldHead);
    expect(
      (request.returned as BatchGetItemCommandOutput).Responses?.[
        reader.tables.snapshot
      ],
    ).toEqual(
      (request.upstream as BatchGetItemCommandOutput).Responses?.[
        reader.tables.snapshot
      ],
    );
    expect(interleaved).toBe(1);
    expect(await writer.store.persistEvent(event(3))).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(await read(reader)).toEqual({
      type: "ok",
      value: {
        headSeqNr: 3,
        snapshot: {
          seqNr: 2,
          manifest: "snapshot/v2",
          aggregate: { count: 2 },
        },
      },
    });
    await physical(reader);
    evidence = { ...evidence, oldHead, interleaved };
  }, 30_000);

  test.each<["head" | "snapshot", string, AttributeValue | undefined]>([
    ["head", "type_name", undefined],
    ["head", "events", undefined],
    ["head", "seq_nr", { S: "1" }],
    ["head", "seq_nr", { N: "9007199254740990.5" }],
    ["snapshot", "seq_nr", undefined],
    ["snapshot", "last_updated_at", undefined],
    ["snapshot", "manifest", undefined],
    ["snapshot", "payload", undefined],
    ["snapshot", "payload", { S: "{}" }],
    ["snapshot", "seq_nr", { N: "9007199254740990.5" }],
    ["snapshot", "seq_nr", { N: "9007199254740992" }],
    ["snapshot", "last_updated_at", { N: "1.0000000000000001" }],
    ["snapshot", "last_updated_at", { N: "9223372036855" }],
  ])(
    "actual saved inconsistency %s.%s %# is Storage before deserialization",
    async (target, field, value) => {
      const input = await scenario();
      await pair(input);
      const before = await physical(input);
      const stored = before[target];
      if (stored === undefined) throw new Error("expected saved item");
      const altered =
        value === undefined
          ? Object.fromEntries(
              Object.entries(stored).filter(([name]) => name !== field),
            )
          : { ...stored, [field]: value };
      await local.observer.send(
        new PutItemCommand({ TableName: input.tables[target], Item: altered }),
      );
      const saved = await physical(input);
      expect(saved[target]).toEqual(altered);
      expect(await read(input)).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      expect(input.snapshotDeserialize).not.toHaveBeenCalled();
      expect(input.eventDeserialize).not.toHaveBeenCalled();
      expect(
        (batches(input)[0].upstream as BatchGetItemCommandOutput).Responses?.[
          input.tables[target]
        ]?.[0],
      ).toEqual(saved[target]);
    },
    30_000,
  );

  test.each<[string, AttributeValue | undefined]>([
    ["seq_nr", { N: "2" }],
    ["seq_nr", { N: "1.0000000000000001" }],
    ["occurred_at", undefined],
    ["occurred_at", { N: "9223372036854775808" }],
    ["payload", undefined],
    ["payload", { S: "{}" }],
  ])(
    "actual saved head event inconsistency %s %# is Storage",
    async (field, value) => {
      const input = await scenario();
      await pair(input);
      const saved = await physical(input);
      const stored = saved.head?.events.L?.[0].M;
      if (stored === undefined) throw new Error("expected head event");
      const alteredEvent =
        value === undefined
          ? Object.fromEntries(
              Object.entries(stored).filter(([name]) => name !== field),
            )
          : { ...stored, [field]: value };
      const altered = { ...saved.head, events: { L: [{ M: alteredEvent }] } };
      await local.observer.send(
        new PutItemCommand({ TableName: input.tables.head, Item: altered }),
      );
      expect((await physical(input)).head).toEqual(altered);
      expect(await read(input)).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      expect(input.snapshotDeserialize).not.toHaveBeenCalled();
      expect(input.eventDeserialize).not.toHaveBeenCalled();
      expect(
        (batches(input)[0].upstream as BatchGetItemCommandOutput).Responses?.[
          input.tables.head
        ]?.[0],
      ).toEqual(altered);
    },
    30_000,
  );

  test.each<["head" | "snapshot", string]>([
    ["head", "aid"],
    ["snapshot", "aid"],
    ["snapshot", "skey"],
  ])(
    "SDK response replacement isolates unpersistable missing %s.%s",
    async (target, field) => {
      const input = await scenario();
      await pair(input);
      const before = await physical(input);
      input.observation.replaceReadSnapshot({
        operation: 1,
        table: input.tables[target],
        request: 1,
        replace: (output) => {
          const items = output.Responses?.[input.tables[target]];
          if (items === undefined) throw new Error("expected SDK items");
          return {
            ...output,
            Responses: {
              ...output.Responses,
              [input.tables[target]]: items.map((item) =>
                Object.fromEntries(
                  Object.entries(item).filter(([name]) => name !== field),
                ),
              ),
            },
          };
        },
      });
      expect(await read(input)).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      const request = batches(input)[0];
      expect(
        (request.upstream as BatchGetItemCommandOutput).Responses?.[
          input.tables[target]
        ]?.[0],
      ).toEqual(before[target]);
      expect(
        (request.returned as BatchGetItemCommandOutput).Responses?.[
          input.tables[target]
        ]?.[0][field],
      ).toBeUndefined();
      expect(await physical(input)).toEqual(before);
      expect(input.snapshotDeserialize).not.toHaveBeenCalled();
    },
    30_000,
  );

  test.each([
    ["0.0", 0],
    ["10e-1", 1],
    ["9.007199254740991e15", Number.MAX_SAFE_INTEGER],
  ])(
    "actual integral snapshot N %s retains its metadata",
    async (raw, expected) => {
      const input = await scenario();
      await pair(input);
      const before = await physical(input);
      await local.observer.send(
        new PutItemCommand({
          TableName: input.tables.snapshot,
          Item: { ...before.snapshot, seq_nr: { N: String(raw) } },
        }),
      );
      expect(await read(input)).toMatchObject({
        type: "ok",
        value: { headSeqNr: 1, snapshot: { seqNr: expected } },
      });
      await physical(input);
    },
    30_000,
  );
});
