import { isDeepStrictEqual } from "node:util";
import {
  type AttributeValue,
  GetItemCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import type { EventEnvelope } from "../../event-envelope";
import type { EventStoreError } from "../../event-store-error";
import type { Result } from "../../result";
import { initializeDynamoDBEventStoreInternal } from "../dynamodb-event-store";
import type { ConformanceCaseResult } from "./conformance/conformance-case-result";
import { loadConformanceData } from "./conformance/conformance-data-loader";
import { jsonAt } from "./conformance/conformance-json-lookup";
import type { ConformanceJsonValue } from "./conformance/conformance-json-value";
import { DynamoDBLocal } from "./dynamodb-local";
import { DynamoDBPersistEventObservation } from "./dynamodb-persist-event-observation";

type Observation = ReturnType<
  DynamoDBPersistEventObservation["snapshot"]
>["observations"][number];
type Failure = { requirement: string; expected: unknown; actual: unknown };
type CanonicalBody = {
  fixtures: {
    events: Record<
      string,
      {
        aggregate_id: { type_name: string; value: string };
        seq_nr: bigint;
        occurred_at: bigint;
        manifest: string;
        payload: ConformanceJsonValue;
      }
    >;
  };
  steps: {
    op: string;
    arguments: {
      event?: string;
      aggregate_id: { type_name: string; value: string };
      seq_nr: bigint;
    };
    expect: { result: string; events?: string[] };
    observe?: unknown;
  }[];
};

/** 原文のexpectとQuery制約を評価する。自然ページングの別fixtureは受け取らない。 */
export function evaluateDynamoDBGetEventsCanonicalRead(
  step: ConformanceJsonValue,
  expected: EventEnvelope[],
  actual: Result<EventEnvelope[], EventStoreError>,
  observations: Observation[],
  journal: string,
): Failure[] {
  let failures: Failure[] = [];
  const check = (
    requirement: string,
    expectedValue: unknown,
    actualValue: unknown,
  ) => {
    if (
      !isDeepStrictEqual(
        structuredClone(expectedValue),
        structuredClone(actualValue),
      )
    )
      failures = [
        ...failures,
        { requirement, expected: expectedValue, actual: actualValue },
      ];
  };
  check("event envelopes", { type: "ok", value: expected }, actual);
  const minimum = jsonAt(
    step,
    "observe",
    "minimum_request_count",
    "read-events",
  ) as number;
  if (observations.length < minimum)
    failures = [
      ...failures,
      {
        requirement: "minimum_request_count.read-events",
        expected: minimum,
        actual: observations.length,
      },
    ];
  const constraints = jsonAt(step, "observe", "requests", 0, "constraints");
  const predicates = jsonAt(constraints, "key_condition", "all") as readonly {
    attribute: string;
    operator: string;
    argument: string;
  }[];
  const id = jsonAt(step, "arguments", "aggregate_id") as {
    type_name: string;
    value: string;
  };
  const values = new Map<string, AttributeValue>([
    ["aggregate_id", { S: `${id.type_name}-${id.value}` }],
    [
      "seq_nr",
      { N: (jsonAt(step, "arguments", "seq_nr") as bigint).toString() },
    ],
  ]);
  for (let n = 0; n < observations.length; n += 1) {
    const input = observations[n].input as QueryCommandInput;
    check("journal table", journal, input.TableName);
    check("journal body", undefined, input.IndexName);
    check("no Limit", undefined, input.Limit);
    check(
      "consistent_read",
      jsonAt(constraints, "consistent_read"),
      input.ConsistentRead,
    );
    check(
      "scan_index_forward",
      jsonAt(constraints, "scan_index_forward"),
      input.ScanIndexForward,
    );
    const conditions = input.KeyConditionExpression?.split(/\s+AND\s+/i).map(
      (part) => {
        const match = /^\s*([#\w]+)\s*(>=|=)\s*(:\w+)\s*$/.exec(part);
        if (match === null) return undefined;
        return {
          attribute: input.ExpressionAttributeNames?.[match[1]] ?? match[1],
          operator: match[2] === "=" ? "eq" : "gte",
          value: input.ExpressionAttributeValues?.[match[3]],
        };
      },
    );
    check("key condition count", predicates.length, conditions?.length);
    for (const predicate of predicates)
      check(
        `key condition ${predicate.attribute}`,
        {
          attribute: predicate.attribute,
          operator: predicate.operator,
          value: values.get(predicate.argument),
        },
        conditions?.find(
          (condition) => condition?.attribute === predicate.attribute,
        ),
      );
    if (jsonAt(constraints, "follow_last_evaluated_key") === true) {
      check(
        "ExclusiveStartKey",
        n === 0
          ? undefined
          : (observations[n - 1].returned as QueryCommandOutput)
              .LastEvaluatedKey,
        input.ExclusiveStartKey,
      );
      const key = (observations[n].returned as QueryCommandOutput)
        .LastEvaluatedKey;
      check(
        "LastEvaluatedKey continuation",
        n + 1 < observations.length,
        key !== undefined && Object.keys(key).length !== 0,
      );
    }
  }
  return failures;
}

/** 指定されたcanonical caseだけを原文の手順で独立実行する。全面適合へ集計しない。 */
export async function observeDynamoDBGetEventsCanonical(root: string) {
  const data = loadConformanceData(root);
  const selected = data.cases.find(
    (c) => c.id === "dynamodb-events-over-one-megabyte",
  );
  if (selected === undefined)
    throw new Error("canonical event read case unavailable");
  const body = selected.body as unknown as CanonicalBody;
  const fixtures = new Map(
    Object.entries(body.fixtures.events).map(([name, raw]) => {
      const nanos = raw.occurred_at;
      const millis =
        nanos / BigInt(1000000) -
        (nanos % BigInt(1000000) < BigInt(0) ? BigInt(1) : BigInt(0));
      return [
        name,
        {
          aggregateId: {
            typeName: raw.aggregate_id.type_name,
            value: raw.aggregate_id.value,
          },
          seqNr: Number(raw.seq_nr),
          occurredAt: new Date(Number(millis)),
          manifest: raw.manifest,
          payload: raw.payload,
        },
      ] as const;
    }),
  );
  const local = await DynamoDBLocal.start();
  try {
    const layout = await local.createTables();
    const client = local.createClient();
    const observation = new DynamoDBPersistEventObservation(client);
    const opened = await initializeDynamoDBEventStoreInternal({
      ...layout,
      client,
    });
    if (opened.type !== "ok")
      throw new Error("canonical store initialization failed", {
        cause: opened.error,
      });
    let failures: (Failure & { operation: number })[] = [];
    let operations: unknown[] = [];
    for (let n = 0; n < body.steps.length; n += 1) {
      const step = body.steps[n];
      const operation = n + 1;
      if (step.op === "persistEvent") {
        const fixture = fixtures.get(step.arguments.event as string);
        if (fixture === undefined)
          throw new Error("canonical event fixture unavailable");
        const result = await opened.value.persistEvent(fixture);
        operations = [...operations, { operation, step, result }];
        if (result.type !== "ok")
          failures = [
            ...failures,
            {
              operation,
              requirement: "persistEvent success",
              expected: step.expect,
              actual: result,
            },
          ];
      } else if (step.op === "getEventsByIdSinceSeqNr") {
        const id = step.arguments.aggregate_id;
        observation.beginReadEvents(layout.tables.journal, operation);
        const result = await opened.value.getEventsByIdSinceSeqNr(
          { typeName: id.type_name, value: id.value },
          Number(step.arguments.seq_nr),
        );
        operations = [...operations, { operation, step, result }];
        const expected = (step.expect.events as string[]).map((name) => {
          const fixture = fixtures.get(name);
          if (fixture === undefined)
            throw new Error("canonical expected fixture unavailable");
          return fixture;
        });
        const requests = observation
          .snapshot()
          .observations.filter((o) => o.readEvents?.operation === operation);
        failures = [
          ...failures,
          ...evaluateDynamoDBGetEventsCanonicalRead(
            step as unknown as ConformanceJsonValue,
            expected,
            result,
            requests,
            layout.tables.journal,
          ).map((failure) => ({ ...failure, operation })),
        ];
      } else throw new Error(`unsupported canonical operation: ${step.op}`);
    }
    const physical = await Promise.all(
      [...fixtures.values()].map((fixture) =>
        local.observer.send(
          new GetItemCommand({
            TableName: layout.tables.journal,
            Key: {
              aid: {
                S: `${fixture.aggregateId.typeName}-${fixture.aggregateId.value}`,
              },
              seq_nr: { N: fixture.seqNr.toString() },
            },
            ConsistentRead: true,
          }),
        ),
      ),
    );
    const result: ConformanceCaseResult = {
      caseId: selected.id,
      rules: selected.rules,
      source: selected.source,
      status: failures.length === 0 ? "passed" : "failed",
      reason:
        failures.length === 0
          ? "原文の封筒・要求制約が成立"
          : "原文の期待または要求制約が不成立",
      ...(failures.length === 0
        ? {}
        : {
            failedOperation: failures[0].operation,
            expected: failures.map((f) => f.expected),
            actual: failures.map((f) => f.actual),
          }),
    };
    observation.assertApplied();
    return {
      result,
      failures,
      dataVersion: data.version,
      canonical: selected,
      nativeFixtures: [...fixtures],
      image: DynamoDBLocal.image,
      layout,
      initialization: opened.value.configuration,
      operations,
      physical,
      observation: observation.snapshot(),
    };
  } finally {
    await local.stop();
  }
}
