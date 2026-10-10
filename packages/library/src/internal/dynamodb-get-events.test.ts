import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import type { AggregateId } from "../aggregate-id";
import type { EventEnvelope } from "../event-envelope";
import { PayloadSerializer } from "../payload-serializer";
import { initializeDynamoDBEventStoreInternal } from "./dynamodb-event-store";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { createDynamoDBGetEvents } from "./dynamodb-get-events";
import { DynamoDBLocal } from "./test/dynamodb-local";
import { DynamoDBPersistEventObservation } from "./test/dynamodb-persist-event-observation";

const id = Object.freeze({ typeName: "Order", value: "a-b" });
const time = new Date("2025-01-02T03:04:05.678Z");
function event(
  seqNr: number,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    aggregateId: id,
    seqNr,
    occurredAt: time,
    manifest: "",
    payload: { count: seqNr },
    ...overrides,
  };
}

test("the read factory handles an empty SDK page and empty terminal key", async () => {
  const handle = jest.fn().mockResolvedValue({
    response: {
      statusCode: 200,
      headers: { "content-type": "application/x-amz-json-1.0" },
      body: Buffer.from('{"LastEvaluatedKey":{}}'),
    },
  });
  const client = new DynamoDBClient({
    region: "us-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: { handle },
  });
  const settings = validateDynamoDBEventStoreInput({
    client,
    tables: { journal: "j", snapshot: "s", head: "h" },
    snapshotAidIndexName: "history",
  });
  try {
    if (settings.type !== "ok") throw new Error("expected settings");
    expect(await createDynamoDBGetEvents(settings.value)(id, 0)).toEqual({
      type: "ok",
      value: [],
    });
    expect(handle).toHaveBeenCalledTimes(1);
  } finally {
    client.destroy();
  }
});

describe("getEventsByIdSinceSeqNr through the configured internal entry with DynamoDB Local 3.3.1", () => {
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
          observations: observations.map((o) => o.snapshot()),
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
                : typeof value === "number" && !Number.isFinite(value)
                  ? { type: "number", value: String(value) }
                  : value,
        2,
      ),
    );
  });

  async function scenario(
    eventSerializer?: PayloadSerializer<unknown>,
    layout?: Awaited<ReturnType<DynamoDBLocal["createTables"]>>,
  ) {
    const selected = layout ?? (await local.createTables());
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client);
    observations = [...observations, observation];
    const snapshotDeserialize = jest.fn();
    const opened = await initializeDynamoDBEventStoreInternal({
      ...selected,
      client,
      eventSerializer,
      snapshotSerializer: {
        serialize: PayloadSerializer.json().serialize,
        deserialize: snapshotDeserialize,
      },
    });
    evidence = {
      ...evidence,
      layouts: [...((evidence.layouts as unknown[]) ?? []), selected],
    };
    if (opened.type !== "ok") throw new Error("expected configured store");
    return {
      ...selected,
      client,
      observation,
      store: opened.value,
      snapshotDeserialize,
      operation: 0,
    };
  }

  async function read(
    input: Awaited<ReturnType<typeof scenario>>,
    aggregateId: AggregateId,
    start: number,
  ) {
    input.operation += 1;
    input.observation.beginReadEvents(input.tables.journal, input.operation);
    const result = await input.store.getEventsByIdSinceSeqNr(
      aggregateId,
      start,
    );
    const suppliedId =
      aggregateId === null || typeof aggregateId !== "object"
        ? aggregateId
        : Object.fromEntries(
            Object.entries(Object.getOwnPropertyDescriptors(aggregateId)).map(
              ([key, descriptor]) => [
                key,
                Object.hasOwn(descriptor, "value")
                  ? descriptor.value
                  : { getter: typeof descriptor.get === "function" },
              ],
            ),
          );
    evidence = {
      ...evidence,
      reads: [
        ...((evidence.reads as unknown[]) ?? []),
        { aggregateId: suppliedId, start, operation: input.operation, result },
      ],
    };
    return result;
  }

  async function physical(
    input: Awaited<ReturnType<typeof scenario>>,
    seqNr = "1",
  ) {
    const result = await local.observer.send(
      new GetItemCommand({
        TableName: input.tables.journal,
        Key: { aid: { S: "Order-a-b" }, seq_nr: { N: seqNr } },
        ConsistentRead: true,
      }),
    );
    evidence = {
      ...evidence,
      physical: [
        ...((evidence.physical as unknown[]) ?? []),
        { seqNr, result },
      ],
    };
    return result.Item;
  }

  function queries(
    input: Awaited<ReturnType<typeof scenario>>,
    operation: number,
  ) {
    return input.observation
      .snapshot()
      .observations.filter((o) => o.readEvents?.operation === operation);
  }

  async function writeNaturalPages(
    input: Awaited<ReturnType<typeof scenario>>,
  ) {
    const fixtures = Array.from({ length: 12 }, (_, n) =>
      event(n + 1, { manifest: "m".repeat(100000) }),
    );
    evidence = { ...evidence, fixtures };
    for (const fixture of fixtures)
      expect(await input.store.persistEvent(fixture)).toEqual({
        type: "ok",
        value: undefined,
      });
    for (const fixture of fixtures)
      expect(await physical(input, fixture.seqNr.toString())).toMatchObject({
        manifest: { S: fixture.manifest },
        seq_nr: { N: fixture.seqNr.toString() },
      });
    return fixtures;
  }

  test("reads the same store before and after both real writes, with inclusive starts and exact aid", async () => {
    const input = await scenario();
    expect(await read(input, id, 0)).toEqual({ type: "ok", value: [] });
    expect(await input.store.persistEvent(event(1))).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(await read(input, id, 0)).toEqual({ type: "ok", value: [event(1)] });
    expect(
      await input.store.persistEventAndSnapshot(event(2), {
        seqNr: 2,
        manifest: "snapshot",
        aggregate: { count: 2 },
      }),
    ).toEqual({ type: "ok", value: undefined });
    expect(await input.store.persistEvent(event(3))).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(
      await input.store.persistEvent(
        event(1, {
          aggregateId: { ...id, value: "a-b-extra" },
          payload: "other",
        }),
      ),
    ).toEqual({ type: "ok", value: undefined });
    expect(await read(input, id, 0)).toEqual({
      type: "ok",
      value: [event(1), event(2), event(3)],
    });
    expect(await read(input, id, 2)).toEqual({
      type: "ok",
      value: [event(2), event(3)],
    });
    expect(await read(input, id, 4)).toEqual({ type: "ok", value: [] });
    expect(await read(input, { ...id, value: "absent" }, 0)).toEqual({
      type: "ok",
      value: [],
    });
    for (const seq of [1, 2, 3])
      expect(await physical(input, seq.toString())).toMatchObject({
        aid: { S: "Order-a-b" },
        occurred_at: {
          N: (BigInt(time.getTime()) * BigInt(1000000)).toString(),
        },
        manifest: { S: "" },
      });
    for (const observation of queries(input, 4)) {
      const request = observation.input as QueryCommandInput;
      expect(request).toMatchObject({
        TableName: input.tables.journal,
        KeyConditionExpression: "aid = :aid AND seq_nr >= :seq_nr",
        ExpressionAttributeValues: {
          ":aid": { S: "Order-a-b" },
          ":seq_nr": { N: "2" },
        },
        ConsistentRead: true,
        ScanIndexForward: true,
      });
      expect(request.IndexName).toBeUndefined();
      expect(request.Limit).toBeUndefined();
    }
    expect(input.snapshotDeserialize).not.toHaveBeenCalled();
  }, 30_000);

  test("a separate Client shares the same destination while a separate three-table store stays isolated", async () => {
    const first = await scenario();
    const shared = await scenario(undefined, first);
    const isolated = await scenario();
    expect(
      await first.store.persistEvent(event(1, { payload: "shared" })),
    ).toEqual({ type: "ok", value: undefined });
    expect(
      await isolated.store.persistEvent(event(1, { payload: "isolated" })),
    ).toEqual({ type: "ok", value: undefined });
    expect(await read(shared, id, 0)).toEqual({
      type: "ok",
      value: [event(1, { payload: "shared" })],
    });
    expect(await read(isolated, id, 0)).toEqual({
      type: "ok",
      value: [event(1, { payload: "isolated" })],
    });
    expect(
      await shared.store.persistEventAndSnapshot(event(2), {
        seqNr: 2,
        manifest: "",
        aggregate: {},
      }),
    ).toEqual({ type: "ok", value: undefined });
    expect(await read(first, id, 2)).toEqual({ type: "ok", value: [event(2)] });
    await physical(first);
    await physical(isolated);
  }, 30_000);

  test.each<[unknown, unknown, string]>([
    [undefined, 0, "T-2"],
    [null, 0, "T-2"],
    [{ typeName: 1, value: "b" }, 0, "T-2"],
    [{ typeName: "Order", value: null }, 0, "T-2"],
    [{ typeName: "Order-Item", value: "b" }, 0, "T-11"],
    [{ typeName: "Order", value: "界".repeat(340) }, 0, "T-12"],
    ...[undefined, null, "1", -1, 0.5, Number.NaN, Infinity, 2 ** 53].map<
      [unknown, unknown, string]
    >((start) => [id, start, "T-9"]),
    [
      {
        get typeName() {
          throw new Error("id access failed");
        },
        value: "b",
      },
      0,
      "T-2",
    ],
  ])(
    "rejects invalid input %# before any Query or restoration",
    async (aggregateId, start, rule) => {
      const deserialize = jest.fn();
      const input = await scenario({ serialize: jest.fn(), deserialize });
      const result = await read(
        input,
        aggregateId as AggregateId,
        start as number,
      );
      expect(result).toMatchObject({
        type: "err",
        error: { type: "contract-violation", rule },
      });
      expect(queries(input, 1)).toHaveLength(0);
      expect(deserialize).not.toHaveBeenCalled();
      evidence = {
        ...evidence,
        queryCount: 0,
        deserializeCount: deserialize.mock.calls.length,
      };
    },
    30_000,
  );

  test("accepts exactly 1024 UTF-8 bytes and ignores user stringification", async () => {
    const input = await scenario();
    const aggregateId = {
      typeName: "Ord",
      value: "界".repeat(340),
      asString: () => "wrong",
      toString: () => "wrong",
    };
    const fixture = event(1, { aggregateId });
    expect(
      Buffer.byteLength(`${aggregateId.typeName}-${aggregateId.value}`),
    ).toBe(1024);
    expect(await input.store.persistEvent(fixture)).toEqual({
      type: "ok",
      value: undefined,
    });
    expect(await read(input, aggregateId, 0)).toEqual({
      type: "ok",
      value: [
        {
          ...fixture,
          aggregateId: {
            typeName: aggregateId.typeName,
            value: aggregateId.value,
          },
        },
      ],
    });
    expect(
      (queries(input, 1)[0].input as QueryCommandInput)
        .ExpressionAttributeValues?.[":aid"],
    ).toEqual({ S: `${aggregateId.typeName}-${aggregateId.value}` });
  }, 30_000);

  test("follows delivered LastEvaluatedKey pages with one capture of input metadata", async () => {
    const input = await scenario();
    const fixtures = await writeNaturalPages(input);
    let typeName: string = id.typeName;
    let value: string = id.value;
    const getTypeName = jest.fn(() => typeName);
    const getValue = jest.fn(() => value);
    const aggregateId = {
      get typeName() {
        return getTypeName();
      },
      get value() {
        return getValue();
      },
    };
    input.observation.beginReadEvents(input.tables.journal, 1);
    const pending = input.store.getEventsByIdSinceSeqNr(aggregateId, 0);
    typeName = "Changed";
    value = "changed";
    const result = await pending;
    evidence = {
      ...evidence,
      result,
      getterCalls: [getTypeName.mock.calls.length, getValue.mock.calls.length],
    };
    expect(result).toEqual({ type: "ok", value: fixtures });
    expect(getTypeName).toHaveBeenCalledTimes(1);
    expect(getValue).toHaveBeenCalledTimes(1);
    const requests = queries(input, 1);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (let n = 0; n < requests.length; n += 1) {
      const request = requests[n].input as QueryCommandInput;
      const response = requests[n].returned as QueryCommandOutput;
      expect(request.ExpressionAttributeValues).toEqual({
        ":aid": { S: "Order-a-b" },
        ":seq_nr": { N: "0" },
      });
      expect(request.ConsistentRead).toBe(true);
      expect(request.ScanIndexForward).toBe(true);
      expect(request.IndexName).toBeUndefined();
      expect(request.Limit).toBeUndefined();
      expect(request.ExclusiveStartKey).toEqual(
        n === 0
          ? undefined
          : (requests[n - 1].returned as QueryCommandOutput).LastEvaluatedKey,
      );
      if (n === requests.length - 1)
        expect(response.LastEvaluatedKey).toBeUndefined();
      else
        expect(
          Object.keys(response.LastEvaluatedKey ?? {}).length,
        ).toBeGreaterThan(0);
    }
  }, 30_000);

  test("a second page failure returns Storage with no restoration or partial success", async () => {
    const json = PayloadSerializer.json();
    const deserialize = jest.fn(json.deserialize);
    const input = await scenario({ serialize: json.serialize, deserialize });
    await writeNaturalPages(input);
    const cause = new Error("planned second page failure");
    input.observation.failReadEvents({
      operation: 1,
      table: input.tables.journal,
      page: 2,
      cause,
    });
    const result = await read(input, id, 0);
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error", cause },
    });
    if (result.type !== "err") throw new Error("expected whole read failure");
    expect(result.error.cause).toBe(cause);
    expect(deserialize).not.toHaveBeenCalled();
    const requests = queries(input, 1);
    expect(requests).toHaveLength(2);
    expect(
      (requests[0].returned as QueryCommandOutput).LastEvaluatedKey,
    ).toBeDefined();
    expect((requests[1].input as QueryCommandInput).ExclusiveStartKey).toEqual(
      (requests[0].returned as QueryCommandOutput).LastEvaluatedKey,
    );
    expect(requests[1].upstream).toBeUndefined();
    input.observation.assertApplied();
    evidence = { ...evidence, deserializeCount: deserialize.mock.calls.length };
  }, 30_000);

  test("an intermediate payload restoration failure returns its cause and no partial array", async () => {
    const json = PayloadSerializer.json();
    const cause = new Error("second payload rejected");
    const deserialize = jest.fn((bytes: Uint8Array, manifest: string) => {
      const payload = json.deserialize(bytes, manifest) as { count: number };
      if (payload.count === 2) throw cause;
      return payload;
    });
    const input = await scenario({ serialize: json.serialize, deserialize });
    for (const seq of [1, 2, 3])
      expect(await input.store.persistEvent(event(seq))).toEqual({
        type: "ok",
        value: undefined,
      });
    const result = await read(input, id, 0);
    expect(result).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "deserialize", cause },
    });
    if (result.type !== "err")
      throw new Error("expected whole restoration failure");
    expect(result.error.cause).toBe(cause);
    expect(deserialize).toHaveBeenCalledTimes(2);
    expect(
      (queries(input, 1)[0].upstream as QueryCommandOutput).Items,
    ).toHaveLength(3);
    await physical(input, "2");
    evidence = { ...evidence, deserializeCount: deserialize.mock.calls.length };
  }, 30_000);

  test("returns opaque domain payloads and owned metadata/bytes without changing physical data", async () => {
    const domain = new Map([["value", Symbol("domain")]]);
    const deserialize = jest.fn((bytes: Uint8Array, manifest: string) => {
      expect(manifest).toBe("domain/v2");
      expect([...bytes]).toEqual([7, 8]);
      bytes[0] = 99;
      return domain;
    });
    const input = await scenario({
      serialize: () => Uint8Array.of(7, 8),
      deserialize,
    });
    const fixture = event(1, { manifest: "domain/v2", payload: domain });
    expect(await input.store.persistEvent(fixture)).toEqual({
      type: "ok",
      value: undefined,
    });
    const before = await physical(input);
    const mutableId: { typeName: string; value: string } = { ...id };
    const first = await read(input, mutableId, 0);
    mutableId.value = "changed";
    if (first.type !== "ok") throw new Error("expected envelope");
    expect(first.value[0].payload).toBe(domain);
    first.value[0].occurredAt.setTime(0);
    expect(Reflect.set(first.value[0].aggregateId, "value", "changed")).toBe(
      false,
    );
    first.value.pop();
    const second = await read(input, id, 0);
    expect(second).toEqual({ type: "ok", value: [fixture] });
    expect(await physical(input)).toEqual(before);
    expect(
      (queries(input, 1)[0].upstream as QueryCommandOutput).Items?.[0].payload
        ?.B,
    ).toEqual(Uint8Array.of(7, 8));
    evidence = {
      ...evidence,
      domainPayloadPreserved:
        second.type === "ok" && second.value[0].payload === domain,
      deserializeCalls: deserialize.mock.calls,
    };
  }, 30_000);

  test.each<[string, AttributeValue | undefined]>([
    ["manifest", undefined],
    ["manifest", { N: "1" }],
    ["payload", undefined],
    ["payload", { S: "{}" }],
    ["occurred_at", undefined],
    ["occurred_at", { S: "1" }],
    ["occurred_at", { N: "9223372036854775808" }],
    ["occurred_at", { N: "-9223372036854775809" }],
    ["occurred_at", { N: "9223372036854775807.1" }],
    ["seq_nr", { N: "0" }],
    ["seq_nr", { N: "0.5" }],
    ["seq_nr", { N: "9007199254740990.5" }],
    ["seq_nr", { N: "9007199254740992" }],
  ])(
    "classifies a physical journal inconsistency %# as Storage",
    async (field, attribute) => {
      const input = await scenario();
      expect(await input.store.persistEvent(event(1))).toEqual({
        type: "ok",
        value: undefined,
      });
      const original = await physical(input);
      if (original === undefined) throw new Error("expected saved item");
      const changed: Record<string, AttributeValue> = Object.fromEntries(
        Object.entries(original).filter(([key]) => key !== field),
      );
      const faulty =
        attribute === undefined ? changed : { ...changed, [field]: attribute };
      await local.observer.send(
        new PutItemCommand({ TableName: input.tables.journal, Item: faulty }),
      );
      const actual = await physical(input, faulty.seq_nr.N);
      const result = await read(input, id, 0);
      evidence = {
        ...evidence,
        faultInput: faulty,
        faultSaved: actual,
        result,
      };
      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      expect(actual).toEqual(faulty);
    },
    30_000,
  );

  test.each<[string, AttributeValue | undefined]>([
    ["aid", undefined],
    ["aid", { N: "1" }],
    ["aid", { S: "Order-other" }],
    ["seq_nr", undefined],
    ["seq_nr", { S: "1" }],
    ["seq_nr", { N: "-1" }],
  ])(
    "records response replacement %# separately from the valid physical item and SDK response",
    async (field, attribute) => {
      const input = await scenario();
      expect(await input.store.persistEvent(event(1))).toEqual({
        type: "ok",
        value: undefined,
      });
      input.observation.replaceReadEvents({
        operation: 1,
        table: input.tables.journal,
        page: 1,
        replace: (output) => ({
          ...output,
          Items: output.Items?.map((item) => {
            const changed = Object.fromEntries(
              Object.entries(item).filter(([key]) => key !== field),
            );
            return attribute === undefined
              ? changed
              : { ...changed, [field]: attribute };
          }),
        }),
      });
      const result = await read(input, id, 0);
      expect(result).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      const saved = queries(input, 1)[0];
      expect((saved.upstream as QueryCommandOutput).Items?.[0]).toEqual(
        await physical(input),
      );
      expect(saved.returned).not.toEqual(saved.upstream);
      input.observation.assertApplied();
    },
    30_000,
  );

  test.each<[string, number]>([
    ["-9223372036854775808", -9223372036855],
    ["9223372036854775807", 9223372036854],
    ["-1", -1],
  ])(
    "converts physical nanos %s only after exact range validation",
    async (nanos, millis) => {
      const input = await scenario();
      expect(await input.store.persistEvent(event(1))).toEqual({
        type: "ok",
        value: undefined,
      });
      const original = await physical(input);
      await local.observer.send(
        new PutItemCommand({
          TableName: input.tables.journal,
          Item: { ...original, occurred_at: { N: nanos } },
        }),
      );
      expect(await read(input, id, 0)).toEqual({
        type: "ok",
        value: [event(1, { occurredAt: new Date(millis) })],
      });
      expect(await physical(input)).toMatchObject({
        occurred_at: { N: nanos },
      });
    },
    30_000,
  );

  test("a real missing journal SDK exception remains the Storage cause", async () => {
    const input = await scenario();
    const journal = `${input.tables.journal}-missing`;
    const getEvents = createDynamoDBGetEvents({
      ...input.store.settings,
      tables: { ...input.tables, journal },
    });
    input.observation.beginReadEvents(journal, 1);
    const result = await getEvents(id, 0);
    evidence = { ...evidence, journal, result };
    expect(result).toMatchObject({
      type: "err",
      error: {
        type: "storage-error",
        cause: expect.any(ResourceNotFoundException),
      },
    });
    if (result.type !== "err") throw new Error("expected storage failure");
    expect(result.error.cause).toBe(queries(input, 1)[0].error);
  }, 30_000);
});
