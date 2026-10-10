import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  QueryCommandInput,
  QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { Result } from "../../../result";
import type { EventEnvelope } from "../../event-envelope";
import { dynamoDBItemSize } from "../dynamodb-item-size";
import { loadConformanceData } from "./conformance/conformance-data-loader";
import { jsonAt } from "./conformance/conformance-json-lookup";
import type { ConformanceJsonValue } from "./conformance/conformance-json-value";
import {
  evaluateDynamoDBGetEventsCanonicalRead,
  observeDynamoDBGetEventsCanonical,
} from "./dynamodb-get-events-canonical-observation";

const root = path.resolve(__dirname, "../../../../../../conformance");
const canonical = loadConformanceData(root).cases.find(
  (c) => c.id === "dynamodb-events-over-one-megabyte",
);
if (canonical === undefined) throw new Error("canonical case unavailable");
const step = jsonAt(canonical.body, "steps", 4) as ConformanceJsonValue;
const sample: EventEnvelope = {
  aggregateId: { typeName: "Order", value: "9" },
  seqNr: 1,
  occurredAt: new Date(0),
  manifest: "",
  payload: { value: 1 },
};
const key = { aid: { S: "Order-9" }, seq_nr: { N: "1" } };
const input = {
  TableName: "journal",
  KeyConditionExpression: " seq_nr >= :start AND aid = :id ",
  ExpressionAttributeValues: { ":id": { S: "Order-9" }, ":start": { N: "1" } },
  ConsistentRead: true,
  ScanIndexForward: true,
};
const onePage = {
  commandName: "QueryCommand",
  wireBody: "",
  input,
  upstream: { $metadata: {}, Items: [] } satisfies QueryCommandOutput,
  returned: { $metadata: {}, Items: [] } satisfies QueryCommandOutput,
};
const twoPages = [
  { ...onePage, returned: { $metadata: {}, Items: [], LastEvaluatedKey: key } },
  { ...onePage, input: { ...input, ExclusiveStartKey: key } },
];

test("one original Query cannot satisfy the canonical minimum, even with all envelopes", () => {
  expect(
    evaluateDynamoDBGetEventsCanonicalRead(
      step,
      [sample],
      Result.ok([sample]),
      [onePage],
      "journal",
    ),
  ).toEqual([
    {
      requirement: "minimum_request_count.read-events",
      expected: 2,
      actual: 1,
    },
  ]);
});

test("canonical evaluation compares metadata and payload and follows actual page keys", () => {
  expect(
    evaluateDynamoDBGetEventsCanonicalRead(
      step,
      [sample],
      Result.ok([sample]),
      twoPages,
      "journal",
    ),
  ).toEqual([]);
  const failures = evaluateDynamoDBGetEventsCanonicalRead(
    step,
    [sample],
    Result.ok([{ ...sample, manifest: "changed" }]),
    twoPages,
    "journal",
  );
  expect(failures.map((f) => f.requirement)).toEqual(["event envelopes"]);
  const brokenPages = [
    twoPages[0],
    {
      ...twoPages[1],
      input: { ...input, ExclusiveStartKey: { ...key, seq_nr: { N: "2" } } },
    },
  ];
  expect(
    evaluateDynamoDBGetEventsCanonicalRead(
      step,
      [sample],
      Result.ok([sample]),
      brokenPages,
      "journal",
    ).map((f) => f.requirement),
  ).toEqual(["ExclusiveStartKey"]);
});

test("compares recorded SDK attributes by value after structured cloning", () => {
  expect(
    evaluateDynamoDBGetEventsCanonicalRead(
      step,
      [sample],
      Result.ok([sample]),
      structuredClone(twoPages),
      "journal",
    ),
  ).toEqual([]);
});

test("reads the unchanged four-envelope case through corrected real SDK pages and an actual continuation Query", async () => {
  const observed = await observeDynamoDBGetEventsCanonical(root);
  const directory = process.env.ESWA_DYNAMODB_CANONICAL_EVIDENCE_DIR;
  if (directory !== undefined) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "canonical.json"),
      JSON.stringify(
        observed,
        (_key, value) =>
          typeof value === "bigint"
            ? value.toString()
            : value instanceof Uint8Array
              ? {
                  type: "Uint8Array",
                  base64: Buffer.from(value).toString("base64"),
                }
              : value,
        2,
      ),
    );
  }
  const queries = observed.observation.observations.filter(
    (o) => o.readEvents !== undefined,
  );
  process.stdout.write(
    `${JSON.stringify({ caseId: observed.result.caseId, status: observed.result.status, failures: observed.failures, queryCount: queries.length, pages: queries.map((q) => ({ rawCount: (q.upstream as QueryCommandOutput).Items?.length, rawLastEvaluatedKey: (q.upstream as QueryCommandOutput).LastEvaluatedKey, deliveredCount: (q.returned as QueryCommandOutput).Items?.length, deliveredLastEvaluatedKey: (q.returned as QueryCommandOutput).LastEvaluatedKey })) })}\n`,
  );
  expect(observed.result.caseId).toBe("dynamodb-events-over-one-megabyte");
  expect(observed.nativeFixtures).toHaveLength(4);
  expect(observed.physical).toHaveLength(4);
  let physicalBytes = 0;
  for (let n = 0; n < observed.physical.length; n += 1) {
    const stored = observed.physical[n].Item;
    if (stored === undefined)
      throw new Error("canonical physical item unavailable");
    expect(dynamoDBItemSize(stored)).toBeLessThan(409600);
    expect(stored.payload.B?.byteLength).toBe(320022);
    const payload = JSON.parse(new TextDecoder().decode(stored.payload.B));
    expect(Buffer.byteLength(payload.text, "utf8")).toBe(320000);
    expect(payload).toEqual(observed.nativeFixtures[n][1].payload);
    physicalBytes += Object.entries(stored).reduce(
      (sum, [name, attribute]) =>
        sum +
        Buffer.byteLength(name, "utf8") +
        (attribute.B !== undefined
          ? attribute.B.byteLength
          : Buffer.byteLength(attribute.S ?? (attribute.N as string), "utf8")),
      0,
    );
  }
  expect(physicalBytes).toBe(1280336);
  expect(physicalBytes).toBeGreaterThan(1048576);
  expect(queries.length).toBeGreaterThanOrEqual(2);
  expect(observed.result.status).toBe("passed");
  expect(observed.failures).toEqual([]);
  const physicalItems = observed.physical.map((p) => p.Item);
  const rawFirst = queries[0].upstream as QueryCommandOutput;
  const deliveredFirst = queries[0].returned as QueryCommandOutput;
  expect(rawFirst.Items).toEqual(physicalItems);
  expect(rawFirst.LastEvaluatedKey).toBeUndefined();
  expect(deliveredFirst.Items).toEqual(rawFirst.Items?.slice(0, 3));
  const last = deliveredFirst.Items?.[2];
  expect(deliveredFirst.LastEvaluatedKey).toEqual({
    aid: last?.aid,
    seq_nr: last?.seq_nr,
  });
  for (let n = 0; n < queries.length; n += 1) {
    const input = queries[n].input as QueryCommandInput;
    const wire = JSON.parse(queries[n].wireBody as string) as QueryCommandInput;
    const raw = queries[n].upstream as QueryCommandOutput;
    const delivered = queries[n].returned as QueryCommandOutput;
    expect(delivered.Items).toEqual(
      raw.Items?.slice(0, delivered.Items?.length),
    );
    expect(wire.ExclusiveStartKey).toEqual(input.ExclusiveStartKey);
    expect(wire.ExclusiveStartKey).toEqual(
      n === 0
        ? undefined
        : (queries[n - 1].returned as QueryCommandOutput).LastEvaluatedKey,
    );
    expect(wire.Limit).toBeUndefined();
  }
  const terminal = queries[queries.length - 1];
  expect(terminal.returned).toEqual(terminal.upstream);
  expect(
    (terminal.returned as QueryCommandOutput).LastEvaluatedKey,
  ).toBeUndefined();
  const receivedItems = queries.flatMap(
    (q) => (q.returned as QueryCommandOutput).Items ?? [],
  );
  expect(receivedItems).toEqual(physicalItems);
  expect(new Set(receivedItems.map((item) => item.seq_nr.N)).size).toBe(4);
  const read = observed.operations[4] as {
    result: Result<EventEnvelope[], unknown>;
  };
  expect(read.result).toEqual(
    Result.ok(observed.nativeFixtures.map(([, fixture]) => fixture)),
  );
}, 120_000);
