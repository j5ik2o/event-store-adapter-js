import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttributeValue,
  type BatchWriteItemCommandInput,
  type BatchWriteItemCommandOutput,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import { EventStore } from "../event-store";
import type { RetentionFailure } from "../retention-failure";
import { initializeDynamoDBEventStoreInternal } from "./dynamodb-event-store";
import { retainDynamoDBSnapshots } from "./dynamodb-snapshot-retention";
import { DynamoDBLocal } from "./test/dynamodb-local";
import { DynamoDBPersistEventObservation } from "./test/dynamodb-persist-event-observation";

const aggregateId = { typeName: "Order", value: "retention" };
const aid = "Order-retention";
function event(seqNr: number) {
  return {
    aggregateId,
    seqNr,
    occurredAt: new Date(-1),
    manifest: "event",
    payload: { count: seqNr },
  };
}
function snapshot(seqNr: number) {
  return { seqNr, manifest: "snapshot", aggregate: { total: seqNr } };
}
function history(
  seqNr: number,
  aggregate = aid,
): Record<string, AttributeValue> {
  return {
    aid: { S: aggregate },
    skey: { N: seqNr.toString() },
    seq_nr: { N: seqNr.toString() },
    active_history_seq_nr: { N: seqNr.toString() },
    last_updated_at: { N: "-1" },
    manifest: { S: "seed" },
    payload: { B: Buffer.from(JSON.stringify({ total: seqNr })) },
  };
}

describe("post-commit retention through public createDynamoDB with DynamoDB Local 3.3.1", () => {
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
          value instanceof Uint8Array
            ? { base64: Buffer.from(value).toString("base64") }
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
        "retention" | "retryLimit" | "logger" | "onRetentionFailure"
      >
    > = {},
  ) {
    const layout = await local.createTables();
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client);
    observations = [...observations, observation];
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const onRetentionFailure = jest.fn<void, [RetentionFailure]>();
    const opened = await EventStore.createDynamoDB({
      ...layout,
      client,
      retention: { count: 1 },
      logger,
      onRetentionFailure,
      ...options,
    });
    if (opened.type !== "ok") throw new Error("open failed");
    evidence = { ...evidence, layout };
    return {
      ...layout,
      store: opened.value,
      observation,
      logger,
      onRetentionFailure,
    };
  }

  async function seedHistory(
    input: Awaited<ReturnType<typeof scenario>>,
    count: number,
  ) {
    for (let seqNr = 1; seqNr <= count; seqNr += 1) {
      expect(await input.store.persistEvent(event(seqNr))).toMatchObject({
        type: "ok",
      });
      await local.observer.send(
        new PutItemCommand({
          TableName: input.tables.snapshot,
          Item: history(seqNr),
        }),
      );
    }
    evidence = { ...evidence, seedCount: count };
  }

  async function physical(
    input: Awaited<ReturnType<typeof scenario>>,
    aggregate = aid,
  ) {
    const rows: Record<string, AttributeValue>[] = [];
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const output = await local.observer.send(
        new QueryCommand({
          TableName: input.tables.snapshot,
          KeyConditionExpression: "aid = :aid",
          ExpressionAttributeValues: { ":aid": { S: aggregate } },
          ConsistentRead: true,
          ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
        }),
      );
      rows.push(...(output.Items ?? []));
      cursor = output.LastEvaluatedKey;
    } while (cursor !== undefined && Object.keys(cursor).length > 0);
    evidence = {
      ...evidence,
      physical: [
        ...((evidence.physical as unknown[]) ?? []),
        { aggregate, rows },
      ],
    };
    return rows;
  }

  function begin(
    input: Awaited<ReturnType<typeof scenario>>,
    operation: number,
  ) {
    input.observation.beginRetention(
      input.tables.snapshot,
      input.snapshotAidIndexName,
      operation,
    );
  }
  function retainedRequests(
    input: Awaited<ReturnType<typeof scenario>>,
    operation: number,
  ) {
    return input.observation
      .snapshot()
      .observations.filter((row) => row.retention?.operation === operation);
  }

  test("reads every GSI page before selecting the latest two histories", async () => {
    const input = await scenario({ retention: { count: 2 } });
    await seedHistory(input, 6);
    begin(input, 1);
    for (const request of [1, 2, 3])
      input.observation.replaceRetentionQuery({
        operation: 1,
        table: input.tables.snapshot,
        request,
        replace: (output) => {
          const items = output.Items ?? [];
          if (items.length <= 2) return output;
          const page = items.slice(0, 2);
          const last = page[page.length - 1];
          return {
            ...output,
            Items: page,
            Count: page.length,
            ScannedCount: page.length,
            LastEvaluatedKey: {
              aid: last.aid,
              skey: last.skey,
              active_history_seq_nr: last.active_history_seq_nr,
            },
          };
        },
      });
    expect(
      await input.store.persistEventAndSnapshot(event(7), snapshot(7)),
    ).toMatchObject({ type: "ok" });
    const requests = retainedRequests(input, 1);
    expect(requests.map((row) => row.retention?.stage)).toEqual([
      "query",
      "query",
      "query",
      "query",
      "delete",
    ]);
    const queries = requests.filter((row) => row.retention?.stage === "query");
    for (const [index, query] of queries.entries()) {
      expect(query.input).toMatchObject({
        TableName: input.tables.snapshot,
        IndexName: input.snapshotAidIndexName,
        ScanIndexForward: false,
        ExpressionAttributeValues: { ":aid": { S: aid } },
      });
      expect(
        (query.input as { ConsistentRead?: boolean }).ConsistentRead,
      ).not.toBe(true);
      if (index > 0)
        expect(
          (query.input as { ExclusiveStartKey?: unknown }).ExclusiveStartKey,
        ).toEqual(
          (queries[index - 1].returned as QueryCommandOutput).LastEvaluatedKey,
        );
    }
    expect((await physical(input)).map((row) => row.skey.N)).toEqual([
      "0",
      "6",
      "7",
    ]);
    input.observation.assertApplied();
  }, 30_000);

  test.each([false, true])(
    "merges the just-written history without double-counting, hidden from GSI = %s",
    async (hidden) => {
      const input = await scenario({ retention: { count: 2 } });
      await seedHistory(input, 3);
      begin(input, 1);
      if (hidden)
        input.observation.replaceRetentionQuery({
          operation: 1,
          table: input.tables.snapshot,
          request: 1,
          replace: (output) => ({
            ...output,
            Items: output.Items?.filter((row) => row.skey.N !== "4"),
          }),
        });
      expect(
        await input.store.persistEventAndSnapshot(event(4), snapshot(4)),
      ).toMatchObject({ type: "ok" });
      expect((await physical(input)).map((row) => row.skey.N)).toEqual([
        "0",
        "3",
        "4",
      ]);
      expect(input.onRetentionFailure).not.toHaveBeenCalled();
      input.observation.assertApplied();
    },
    30_000,
  );

  test("splits more than 25 real deletes and leaves current, configuration and other aggregates intact", async () => {
    const input = await scenario();
    await seedHistory(input, 30);
    const foreign = history(1, "Order-foreign");
    await local.observer.send(
      new PutItemCommand({ TableName: input.tables.snapshot, Item: foreign }),
    );
    const configuration = await local.readConfiguration(input.tables);
    begin(input, 1);
    expect(
      await input.store.persistEventAndSnapshot(event(31), snapshot(31)),
    ).toMatchObject({ type: "ok" });
    const deletes = retainedRequests(input, 1).filter(
      (row) => row.retention?.stage === "delete",
    );
    expect(
      deletes.map(
        (row) =>
          (row.input as BatchWriteItemCommandInput).RequestItems?.[
            input.tables.snapshot
          ].length,
      ),
    ).toEqual([25, 5]);
    expect((await physical(input)).map((row) => row.skey.N)).toEqual([
      "0",
      "31",
    ]);
    expect(await physical(input, "Order-foreign")).toEqual([foreign]);
    const afterConfiguration = await local.readConfiguration(input.tables);
    for (const table of ["journal", "snapshot", "head"] as const)
      expect(afterConfiguration[table].Item).toEqual(configuration[table].Item);
    expect(await input.store.getLatestSnapshotById(aggregateId)).toEqual({
      type: "ok",
      value: { headSeqNr: 31, snapshot: snapshot(31) },
    });
    input.observation.assertApplied();
  }, 30_000);

  test("really processes the complement and resends only the returned unprocessed deletes", async () => {
    const input = await scenario();
    await seedHistory(input, 4);
    begin(input, 1);
    input.observation.deferRetentionDeletes({
      operation: 1,
      table: input.tables.snapshot,
      request: 1,
      pendingCount: 2,
      observer: local.observer,
    });
    expect(
      await input.store.persistEventAndSnapshot(event(5), snapshot(5)),
    ).toMatchObject({ type: "ok" });
    const deletes = retainedRequests(input, 1).filter(
      (row) => row.retention?.stage === "delete",
    );
    expect(deletes).toHaveLength(2);
    const firstRequest = (deletes[0].input as BatchWriteItemCommandInput)
      .RequestItems?.[input.tables.snapshot];
    expect(
      deletes[0].delegatedDelete?.RequestItems?.[input.tables.snapshot],
    ).toEqual(firstRequest?.slice(2));
    expect(deletes[0].upstream).toMatchObject({
      $metadata: { httpStatusCode: 200 },
    });
    expect(
      (deletes[1].input as BatchWriteItemCommandInput).RequestItems,
    ).toEqual(
      (deletes[0].returned as BatchWriteItemCommandOutput).UnprocessedItems,
    );
    expect((await physical(input)).map((row) => row.skey.N)).toEqual([
      "0",
      "5",
    ]);
    expect(input.onRetentionFailure).not.toHaveBeenCalled();
    input.observation.assertApplied();
  }, 30_000);

  test("stops at the retry limit, preserves committed reads, does no event-only retention and recovers on the same store", async () => {
    const input = await scenario({ retryLimit: 1 });
    await seedHistory(input, 4);
    begin(input, 1);
    for (const request of [1, 2])
      input.observation.deferRetentionDeletes({
        operation: 1,
        table: input.tables.snapshot,
        request,
        pendingCount: 25,
        observer: local.observer,
      });
    expect(
      await input.store.persistEventAndSnapshot(event(5), snapshot(5)),
    ).toEqual({ type: "ok", value: undefined });
    expect(
      retainedRequests(input, 1).filter(
        (row) => row.retention?.stage === "delete",
      ),
    ).toHaveLength(2);
    expect((await physical(input)).map((row) => row.skey.N)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(input.logger.error).toHaveBeenCalledTimes(1);
    expect(input.onRetentionFailure).toHaveBeenCalledTimes(1);
    expect(input.logger.error).toHaveBeenCalledWith(
      input.onRetentionFailure.mock.calls[0][0],
    );
    expect(await input.store.getLatestSnapshotById(aggregateId)).toEqual({
      type: "ok",
      value: { headSeqNr: 5, snapshot: snapshot(5) },
    });
    expect(
      await input.store.getEventsByIdSinceSeqNr(aggregateId, 5),
    ).toMatchObject({
      type: "ok",
      value: [{ seqNr: 5, payload: { count: 5 } }],
    });
    begin(input, 2);
    expect(await input.store.persistEvent(event(6))).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(retainedRequests(input, 2)).toEqual([]);
    expect(input.onRetentionFailure).toHaveBeenCalledTimes(1);
    expect(input.logger.error).toHaveBeenCalledTimes(1);
    expect((await physical(input)).map((row) => row.skey.N)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    begin(input, 3);
    expect(
      await input.store.persistEventAndSnapshot(event(7), snapshot(7)),
    ).toEqual({ type: "ok", value: undefined });
    expect((await physical(input)).map((row) => row.skey.N)).toEqual([
      "0",
      "7",
    ]);
    expect(input.onRetentionFailure).toHaveBeenCalledTimes(1);
    input.observation.assertApplied();
  }, 30_000);

  test.each(["query", "delete", "ttl"] as const)(
    "a final %s failure preserves commit and its next pair really recovers",
    async (stage) => {
      const input = await scenario({
        retention:
          stage === "ttl"
            ? { count: 1, mode: { type: "ttl", graceSeconds: 120 } }
            : { count: 1 },
      });
      await seedHistory(input, 1);
      begin(input, 1);
      const cause = new Error(`${stage} unavailable`);
      input.observation.failRetention({
        operation: 1,
        table: input.tables.snapshot,
        stage,
        request: 1,
        cause,
      });
      expect(
        await input.store.persistEventAndSnapshot(event(2), snapshot(2)),
      ).toEqual({ type: "ok", value: undefined });
      const before = await physical(input);
      expect(before.map((row) => row.skey.N)).toEqual(["0", "1", "2"]);
      expect(input.logger.error).toHaveBeenCalledWith({
        kind: "retention-failure",
        aggregateId: aid,
        cause,
      });
      expect(input.onRetentionFailure).toHaveBeenCalledWith({
        kind: "retention-failure",
        aggregateId: aid,
        cause,
      });
      expect(await input.store.getLatestSnapshotById(aggregateId)).toEqual({
        type: "ok",
        value: { headSeqNr: 2, snapshot: snapshot(2) },
      });
      begin(input, 2);
      expect(await input.store.persistEvent(event(3))).toMatchObject({
        type: "ok",
      });
      expect(retainedRequests(input, 2)).toEqual([]);
      expect(input.onRetentionFailure).toHaveBeenCalledTimes(1);
      expect(await physical(input)).toEqual(before);
      begin(input, 3);
      expect(
        await input.store.persistEventAndSnapshot(event(4), snapshot(4)),
      ).toMatchObject({ type: "ok" });
      const after = await physical(input);
      if (stage === "ttl") {
        expect(after.map((row) => row.skey.N)).toEqual(["0", "1", "2", "4"]);
        for (const row of after.filter((row) =>
          ["1", "2"].includes(row.skey.N as string),
        )) {
          expect(row.ttl?.N).toBeDefined();
          expect(row.active_history_seq_nr).toBeUndefined();
        }
      } else expect(after.map((row) => row.skey.N)).toEqual(["0", "4"]);
      expect(input.onRetentionFailure).toHaveBeenCalledTimes(1);
      input.observation.assertApplied();
    },
    30_000,
  );

  test("uses current epoch seconds and preserves a previously marked TTL even with a stale GSI entry", async () => {
    const input = await scenario({
      retention: { count: 1, mode: { type: "ttl", graceSeconds: 120 } },
    });
    await seedHistory(input, 1);
    const initial = await local.observer.send(
      new QueryCommand({
        TableName: input.tables.snapshot,
        IndexName: input.snapshotAidIndexName,
        KeyConditionExpression: "aid = :aid",
        ExpressionAttributeValues: { ":aid": { S: aid } },
      }),
    );
    const stale = initial.Items?.[0];
    if (stale === undefined) throw new Error("seed missing from index");
    const beforeSeconds = Date.now() / 1000;
    begin(input, 1);
    expect(
      await input.store.persistEventAndSnapshot(event(2), snapshot(2)),
    ).toMatchObject({ type: "ok" });
    const afterSeconds = Date.now() / 1000;
    const marked = (await physical(input)).find((row) => row.skey.N === "1");
    if (marked === undefined || marked.ttl?.N === undefined)
      throw new Error("TTL missing");
    expect(Number(marked.ttl.N)).toBeGreaterThanOrEqual(
      Math.ceil(beforeSeconds) + 120,
    );
    expect(Number(marked.ttl.N)).toBeLessThanOrEqual(
      Math.ceil(afterSeconds) + 120,
    );
    expect(marked.active_history_seq_nr).toBeUndefined();
    begin(input, 2);
    input.observation.replaceRetentionQuery({
      operation: 2,
      table: input.tables.snapshot,
      request: 1,
      replace: (output) => ({
        ...output,
        Items: [...(output.Items ?? []), stale],
      }),
    });
    expect(
      await input.store.persistEventAndSnapshot(event(3), snapshot(3)),
    ).toMatchObject({ type: "ok" });
    expect((await physical(input)).find((row) => row.skey.N === "1")).toEqual(
      marked,
    );
    const updates = retainedRequests(input, 2).filter(
      (row) => row.retention?.stage === "ttl",
    );
    expect(updates).toHaveLength(2);
    expect(
      updates.find(
        (row) => (row.input as UpdateItemCommandInput).Key?.skey.N === "1",
      )?.error,
    ).toMatchObject({ name: "ConditionalCheckFailedException" });
    for (const row of updates)
      expect(row.input).toMatchObject({
        ConditionExpression: "attribute_exists(active_history_seq_nr)",
        UpdateExpression: "SET #ttl = :expires REMOVE active_history_seq_nr",
        ExpressionAttributeNames: { "#ttl": "ttl" },
      });
    expect(input.onRetentionFailure).not.toHaveBeenCalled();
    input.observation.assertApplied();
  }, 30_000);

  test.each(["throw", "reject"])(
    "logger and callback %s leave the public committed operation successful",
    async (mode) => {
      const error = jest.fn(() => {
        if (mode === "throw") throw new Error("logger failed");
        return Promise.reject(new Error("logger failed"));
      });
      const callback = jest.fn(() => {
        if (mode === "throw") throw new Error("callback failed");
        return Promise.reject(new Error("callback failed"));
      });
      const fallback = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        const input = await scenario({
          logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error },
          onRetentionFailure: callback,
        });
        begin(input, 1);
        input.observation.failRetention({
          operation: 1,
          table: input.tables.snapshot,
          stage: "query",
          request: 1,
          cause: new Error("query failed"),
        });
        expect(
          await input.store.persistEventAndSnapshot(event(1), snapshot(1)),
        ).toEqual({ type: "ok", value: undefined });
        expect(callback).toHaveBeenCalledTimes(1);
        expect(await input.store.getLatestSnapshotById(aggregateId)).toEqual({
          type: "ok",
          value: { headSeqNr: 1, snapshot: snapshot(1) },
        });
        expect(
          await input.store.getEventsByIdSinceSeqNr(aggregateId, 1),
        ).toMatchObject({ type: "ok", value: [{ seqNr: 1 }] });
        input.observation.assertApplied();
      } finally {
        fallback.mockRestore();
      }
    },
    30_000,
  );

  test("failed transactions and event-only operations send no retention request or notification", async () => {
    const input = await scenario();
    begin(input, 1);
    expect(
      await input.store.persistEventAndSnapshot(event(2), snapshot(2)),
    ).toMatchObject({ type: "err" });
    expect(await input.store.persistEvent(event(1))).toMatchObject({
      type: "ok",
    });
    expect(retainedRequests(input, 1)).toEqual([]);
    expect(input.logger.error).not.toHaveBeenCalled();
    expect(input.onRetentionFailure).not.toHaveBeenCalled();
    input.observation.assertApplied();
  }, 30_000);
  test("passes the internal clock through initialization and the pair write without changing the saved TTL integer", async () => {
    const layout = await local.createTables();
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client);
    observations = [...observations, observation];
    const clock = jest.fn(() => 10.125);
    const opened = await initializeDynamoDBEventStoreInternal(
      {
        ...layout,
        client,
        retention: {
          count: 1,
          mode: { type: "ttl", graceSeconds: Number.MAX_SAFE_INTEGER },
        },
      },
      { clock },
    );
    if (opened.type !== "ok") throw new Error("open failed");
    expect(
      await opened.value.persistEventAndSnapshot(event(1), snapshot(1)),
    ).toMatchObject({ type: "ok" });
    expect(clock).not.toHaveBeenCalled();
    expect(await opened.value.persistEvent(event(2))).toMatchObject({
      type: "ok",
    });
    expect(clock).not.toHaveBeenCalled();
    observation.beginRetention(
      layout.tables.snapshot,
      layout.snapshotAidIndexName,
      1,
    );
    expect(
      await opened.value.persistEventAndSnapshot(event(3), snapshot(3)),
    ).toMatchObject({ type: "ok" });
    const item = await local.observer.send(
      new QueryCommand({
        TableName: layout.tables.snapshot,
        KeyConditionExpression: "aid = :aid AND skey = :skey",
        ExpressionAttributeValues: { ":aid": { S: aid }, ":skey": { N: "1" } },
        ConsistentRead: true,
      }),
    );
    expect(item.Items?.[0].ttl).toEqual({ N: "9007199254741002" });
    expect(item.Items?.[0].active_history_seq_nr).toBeUndefined();
    expect(clock).toHaveBeenCalledTimes(1);
    evidence = { ...evidence, layout, stored: item };
    observation.assertApplied();
  }, 30_000);
});

function fixtureClient(
  queryOutput: Omit<QueryCommandOutput, "$metadata">,
  deleteOutput:
    | Omit<BatchWriteItemCommandOutput, "$metadata">
    | "unprocessed" = {},
) {
  const handle = jest.fn(
    async (request: { headers: Record<string, string>; body: string }) => {
      const input = JSON.parse(request.body);
      const query = request.headers["x-amz-target"].endsWith(".Query");
      const output = query
        ? queryOutput
        : deleteOutput === "unprocessed"
          ? { UnprocessedItems: input.RequestItems }
          : deleteOutput;
      return {
        response: {
          statusCode: 200,
          headers: { "content-type": "application/x-amz-json-1.0" },
          body: Buffer.from(JSON.stringify(output)),
        },
      };
    },
  );
  const client = new DynamoDBClient({
    region: "us-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: { handle },
  });
  return { client, handle };
}

test.each([0, Number.MAX_SAFE_INTEGER])(
  "ceilings fractional seconds before adding grace %s without losing integer precision",
  async (graceSeconds) => {
    const { client, handle } = fixtureClient({ Items: [history(1)] });
    try {
      await retainDynamoDBSnapshots(
        {
          client,
          tables: { journal: "journal", snapshot: "snapshot", head: "head" },
          snapshotAidIndexName: "history",
          retention: { count: 1, mode: { type: "ttl", graceSeconds } },
          retryLimit: 0,
        },
        aid,
        2,
        { clock: () => 10.125 },
      );
      const update = JSON.parse(handle.mock.calls[1][0].body);
      expect(update.ExpressionAttributeValues[":expires"]).toEqual({
        N: (BigInt(11) + BigInt(graceSeconds)).toString(),
      });
      expect(update.ConditionExpression).toBe(
        "attribute_exists(active_history_seq_nr)",
      );
      expect(update.ExpressionAttributeNames).toEqual({ "#ttl": "ttl" });
    } finally {
      client.destroy();
    }
  },
);

test("uses 50ms exponential waits capped at one second and stops at the configured retry count", async () => {
  const { client, handle } = fixtureClient(
    { Items: [history(1)] },
    "unprocessed",
  );
  const sleep = jest.fn().mockResolvedValue(undefined);
  try {
    await expect(
      retainDynamoDBSnapshots(
        {
          client,
          tables: { journal: "journal", snapshot: "snapshot", head: "head" },
          snapshotAidIndexName: "history",
          retention: { count: 1, mode: { type: "delete" } },
          retryLimit: 7,
        },
        aid,
        2,
        { sleep },
      ),
    ).rejects.toThrow("retry limit reached");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      50, 100, 200, 400, 800, 1000, 1000,
    ]);
    expect(handle).toHaveBeenCalledTimes(9);
  } finally {
    client.destroy();
  }
});

test.each([undefined, { N: "1.5" }])(
  "rejects an invalid stored history key %p before performing deletes",
  async (skey) => {
    const { client, handle } = fixtureClient({
      Items: [{ ...history(1), skey } as Record<string, AttributeValue>],
    });
    try {
      await expect(
        retainDynamoDBSnapshots(
          {
            client,
            tables: { journal: "journal", snapshot: "snapshot", head: "head" },
            snapshotAidIndexName: "history",
            retention: { count: 1, mode: { type: "delete" } },
            retryLimit: 0,
          },
          aid,
          2,
        ),
      ).rejects.toMatchObject({ type: "storage-error" });
      expect(handle).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
    }
  },
);

test.each([{}, { Items: [], LastEvaluatedKey: {} }])(
  "keeps the just-written history when a terminal GSI page is empty: %p",
  async (queryOutput) => {
    const { client, handle } = fixtureClient(queryOutput);
    try {
      await retainDynamoDBSnapshots(
        {
          client,
          tables: { journal: "journal", snapshot: "snapshot", head: "head" },
          snapshotAidIndexName: "history",
          retention: { count: 1, mode: { type: "delete" } },
          retryLimit: 0,
        },
        aid,
        2,
      );
      expect(handle).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
    }
  },
);

test("an empty UnprocessedItems table does not cause another delete request", async () => {
  const { client, handle } = fixtureClient(
    { Items: [history(1)] },
    { UnprocessedItems: { snapshot: [] } },
  );
  try {
    await retainDynamoDBSnapshots(
      {
        client,
        tables: { journal: "journal", snapshot: "snapshot", head: "head" },
        snapshotAidIndexName: "history",
        retention: { count: 1, mode: { type: "delete" } },
        retryLimit: 0,
      },
      aid,
      2,
    );
    expect(handle).toHaveBeenCalledTimes(2);
  } finally {
    client.destroy();
  }
});

test("an omitted UnprocessedItems field completes deletion without another request", async () => {
  const { client } = fixtureClient({});
  const send = jest
    .spyOn(client, "send")
    .mockImplementationOnce(async () => ({
      $metadata: {},
      Items: [history(1)],
    }))
    .mockImplementationOnce(async () => ({ $metadata: {} }));
  try {
    await retainDynamoDBSnapshots(
      {
        client,
        tables: { journal: "journal", snapshot: "snapshot", head: "head" },
        snapshotAidIndexName: "history",
        retention: { count: 1, mode: { type: "delete" } },
        retryLimit: 0,
      },
      aid,
      2,
    );
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    send.mockRestore();
    client.destroy();
  }
});
