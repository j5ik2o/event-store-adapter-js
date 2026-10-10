import assert from "node:assert/strict";
import {
  type AttributeValue,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  type DynamoDBClient,
  GetItemCommand,
  type GlobalSecondaryIndexDescription,
  QueryCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBPersistEventObservation,
  journalItemBytes,
} from "../dynamodb-persist-event-observation";
import {
  compareDynamoDBItem,
  declaredItemKey,
} from "./conformance-dynamodb-items";
import {
  aggregateIdOf,
  integerOf,
  listOf,
  recordOf,
  textOf,
} from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";

type Observation = ReturnType<
  DynamoDBPersistEventObservation["snapshot"]
>["observations"][number];
type Tables = Readonly<{ journal: string; snapshot: string; head: string }>;
type Request = {
  TableName?: string;
  IndexName?: string;
  ConsistentRead?: boolean;
  ScanIndexForward?: boolean;
  ExclusiveStartKey?: unknown;
  KeyConditionExpression?: string;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  Key?: Record<string, AttributeValue>;
  RequestItems?: Record<
    string,
    | { Keys?: Record<string, AttributeValue>[]; ConsistentRead?: boolean }
    | unknown[]
  >;
  TransactItems?: {
    Put?: {
      TableName: string;
      Item: Record<string, AttributeValue>;
      ConditionExpression?: string;
      ReturnValuesOnConditionCheckFailure?: string;
    };
    Update?: {
      TableName: string;
      ReturnValuesOnConditionCheckFailure?: string;
    };
  }[];
  Limit?: number;
};

/** 別実Clientで項目・配置を読み、観測したSDK入力と受信応答を比較する。 */
export class ConformanceDynamoDBObservation {
  private bindings = new Map<string, string>();
  private physical: unknown[] = [];
  private sleeps: { operation: number; milliseconds: number }[] = [];

  constructor(
    private readonly observer: DynamoDBClient,
    private readonly tables: Tables,
    private readonly indexName: string,
    private readonly observation: DynamoDBPersistEventObservation,
    private readonly operation: () => number,
  ) {}

  sleep(milliseconds: number): void {
    this.sleeps = [
      ...this.sleeps,
      { operation: this.operation(), milliseconds },
    ];
  }

  async readHistory(id: { typeName: string; value: string }) {
    const items: Record<string, AttributeValue>[] = [];
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const read = await this.observer.send(
        new QueryCommand({
          TableName: this.tables.snapshot,
          KeyConditionExpression: "aid = :aid",
          ExpressionAttributeValues: {
            ":aid": { S: `${id.typeName}-${id.value}` },
          },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      this.physical = [
        ...this.physical,
        { operation: this.operation(), history: read },
      ];
      items.push(...(read.Items ?? []));
      cursor = read.LastEvaluatedKey;
    } while (cursor !== undefined && Object.keys(cursor).length > 0);
    const history = items.filter(
      (item) => BigInt(item.skey.N as string) > BigInt(0),
    );
    return {
      active: history
        .filter((item) => item.active_history_seq_nr !== undefined)
        .map((item) => BigInt(item.skey.N as string)),
      marked: history
        .filter((item) => item.ttl !== undefined)
        .map((item) => ({
          seqNr: BigInt(item.skey.N as string),
          expires: Number(item.ttl.N),
        })),
    };
  }

  async check(
    observeValue: ConformanceJsonValue,
    args: ConformanceJsonValue,
  ): Promise<void> {
    const observe = recordOf(observeValue);
    const allowed = [
      "history",
      "notifications",
      "items",
      "requests",
      "no_requests_in_phases",
      "request_count",
      "minimum_request_count",
    ];
    assert.ok(
      Object.keys(observe).every((key) => allowed.includes(key)),
      "unsupported observation",
    );
    for (const specification of listOf(observe.items ?? [])) {
      const spec = recordOf(specification);
      const read = await this.observer.send(
        new GetItemCommand({
          TableName: this.tables[textOf(spec.table) as keyof Tables],
          Key: declaredItemKey(specification),
          ConsistentRead: true,
        }),
      );
      this.physical = [
        ...this.physical,
        { operation: this.operation(), specification, item: read },
      ];
      compareDynamoDBItem(specification, read.Item, this.bindings);
    }
    const requests = this.observation
      .snapshot()
      .observations.filter((r) => r.operation === this.operation());
    for (const phase of listOf(observe.no_requests_in_phases ?? []))
      assert.equal(
        requests.filter((r) => r.phase === phase).length,
        0,
        `forbidden phase ${String(phase)}`,
      );
    for (const [phase, count] of Object.entries(
      recordOf(observe.request_count ?? {}),
    ))
      assert.equal(
        requests.filter((r) => r.phase === phase).length,
        Number(integerOf(count)),
        `request count ${phase}`,
      );
    for (const [phase, count] of Object.entries(
      recordOf(observe.minimum_request_count ?? {}),
    ))
      assert.ok(
        requests.filter((r) => r.phase === phase).length >=
          Number(integerOf(count)),
        `minimum request count ${phase}`,
      );
    let position = -1;
    for (const declaration of listOf(observe.requests ?? [])) {
      const expected = recordOf(declaration);
      position = requests.findIndex(
        (r, index) =>
          index > position &&
          r.commandName === `${textOf(expected.api)}Command` &&
          r.phase === expected.phase,
      );
      assert.ok(
        position >= 0,
        "request declarations must match distinct requests in order",
      );
      this.checkConstraints(
        recordOf(expected.constraints),
        requests[position],
        requests,
        args,
      );
    }
    await this.checkReadEventPages(requests);
  }

  private equal(actual: unknown, expected: unknown, message?: string): void {
    assert.deepEqual(
      structuredClone(actual),
      structuredClone(expected),
      message,
    );
  }

  private names(input: Request, expression: string): string {
    return expression.replace(/#[A-Za-z0-9_]+/g, (alias) => {
      const name = input.ExpressionAttributeNames?.[alias];
      assert.ok(name, `unbound attribute name ${alias}`);
      return name;
    });
  }

  private keyNames(request: Request): string[] {
    return Object.entries(request.RequestItems ?? {})
      .flatMap(([table, value]) => {
        assert.ok(!Array.isArray(value));
        const name = (Object.keys(this.tables) as (keyof Tables)[]).find(
          (name) => this.tables[name] === table,
        );
        assert.ok(name);
        return (value.Keys ?? []).map(
          (key) =>
            `${name}:${key.aid.S}${key.seq_nr === undefined && key.skey === undefined ? "" : `:${key.seq_nr?.N ?? key.skey?.N}`}`,
        );
      })
      .sort();
  }

  private checkConstraints(
    constraints: Readonly<Record<string, ConformanceJsonValue>>,
    observed: Observation,
    all: Observation[],
    argsValue: ConformanceJsonValue,
  ): void {
    const input = observed.input as Request;
    const group = all.filter((r) => r.phase === observed.phase);
    const index = group.indexOf(observed);
    const previous = group[index - 1];
    for (const [key, expected] of Object.entries(constraints)) {
      switch (key) {
        case "table":
          assert.equal(
            input.TableName,
            this.tables[textOf(expected) as keyof Tables],
          );
          break;
        case "index":
          assert.equal(expected, "configured-history-index");
          assert.equal(input.IndexName, this.indexName);
          break;
        case "scan_index_forward":
          assert.equal(input.ScanIndexForward ?? true, expected);
          break;
        case "consistent_read":
          assert.equal(input.ConsistentRead, expected);
          break;
        case "consistent_read_all_tables":
          for (const value of Object.values(input.RequestItems ?? {})) {
            assert.ok(!Array.isArray(value));
            assert.equal(value.ConsistentRead, true);
          }
          break;
        case "keys":
          this.equal(this.keyNames(input), listOf(expected).map(textOf).sort());
          break;
        case "head_and_current_snapshot": {
          const id = aggregateIdOf(recordOf(argsValue).aggregate_id);
          this.equal(
            this.keyNames(input),
            [
              `head:${id.typeName}-${id.value}`,
              `snapshot:${id.typeName}-${id.value}:0`,
            ].sort(),
          );
          break;
        }
        case "only_unprocessed_keys": {
          assert.ok(previous);
          const unprocessed = (
            previous.returned as { UnprocessedKeys: Request["RequestItems"] }
          ).UnprocessedKeys;
          this.equal(
            this.keyNames(input),
            this.keyNames({ RequestItems: unprocessed }),
          );
          break;
        }
        case "exponential_backoff": {
          const sleeps = this.sleeps.filter(
            (s) => s.operation === this.operation(),
          );
          assert.ok(sleeps.length > 0, "retry must call sleep");
          sleeps.forEach((sleep, index) => {
            assert.equal(sleep.milliseconds, Math.min(50 * 2 ** index, 1000));
          });
          break;
        }
        case "put_tables":
          this.equal(
            (input.TransactItems ?? [])
              .map((action) => {
                const name = (
                  Object.keys(this.tables) as (keyof Tables)[]
                ).find((name) => this.tables[name] === action.Put?.TableName);
                assert.ok(name);
                return name;
              })
              .sort(),
            listOf(expected).map(textOf).sort(),
          );
          break;
        case "same_store_id": {
          const values = (input.TransactItems ?? []).map(
            (action) => action.Put?.Item.store_id.S,
          );
          assert.equal(new Set(values).size, 1);
          assert.ok(typeof values[0] === "string" && values[0].length > 0);
          break;
        }
        case "layout_version":
          for (const action of input.TransactItems ?? [])
            assert.equal(
              BigInt(action.Put?.Item.layout_version.N as string),
              integerOf(expected),
            );
          break;
        case "head_return_values_on_condition_check_failure": {
          const head = (input.TransactItems ?? []).find(
            (action) =>
              (action.Put ?? action.Update)?.TableName === this.tables.head,
          );
          assert.ok(head);
          assert.equal(
            (head.Put ?? head.Update)?.ReturnValuesOnConditionCheckFailure,
            expected,
          );
          break;
        }
        case "condition": {
          const condition = recordOf(expected);
          const expressions =
            input.TransactItems === undefined
              ? [input.ConditionExpression]
              : input.TransactItems.map(
                  (action) => action.Put?.ConditionExpression,
                );
          for (const expression of expressions) {
            assert.ok(expression);
            const resolved = this.names(input, expression).replace(/\s+/g, "");
            if (condition.attribute_exists !== undefined)
              assert.equal(
                resolved,
                `attribute_exists(${textOf(condition.attribute_exists)})`,
              );
            if (condition.attribute_not_exists !== undefined)
              assert.equal(
                resolved,
                `attribute_not_exists(${textOf(condition.attribute_not_exists)})`,
              );
          }
          break;
        }
        case "key_condition": {
          assert.ok(input.KeyConditionExpression);
          const parsed = this.names(input, input.KeyConditionExpression)
            .split(/\s+AND\s+/i)
            .map((condition) => {
              const match =
                /^\s*([A-Za-z0-9_]+)\s*(>=|=)\s*(:[A-Za-z0-9_]+)\s*$/.exec(
                  condition,
                );
              assert.ok(match, "unsupported key condition");
              return {
                attribute: match[1],
                operator: match[2] === "=" ? "eq" : "gte",
                value: input.ExpressionAttributeValues?.[match[3]],
              };
            });
          const args = recordOf(argsValue);
          const id = aggregateIdOf(args.aggregate_id);
          const desired = listOf(recordOf(expected).all).map((condition) => {
            const declared = recordOf(condition);
            return {
              attribute: declared.attribute,
              operator: declared.operator,
              value:
                declared.argument === "aggregate_id"
                  ? { S: `${id.typeName}-${id.value}` }
                  : { N: integerOf(args.seq_nr).toString() },
            };
          });
          this.equal(
            parsed.sort((a, b) => a.attribute.localeCompare(b.attribute)),
            desired.sort((a, b) =>
              String(a.attribute).localeCompare(String(b.attribute)),
            ),
          );
          break;
        }
        case "expression_attribute_names":
          this.equal(input.ExpressionAttributeNames, expected);
          break;
        case "expires":
          assert.equal(
            BigInt(input.ExpressionAttributeValues?.[":expires"].N as string),
            integerOf(expected),
          );
          break;
        case "target_seq_nrs":
          this.equal(
            group
              .map((r) => BigInt((r.input as Request).Key?.skey.N as string))
              .sort((a, b) => Number(a - b)),
            listOf(expected)
              .map(integerOf)
              .sort((a, b) => Number(a - b)),
          );
          break;
        case "update": {
          assert.ok(input.UpdateExpression);
          const expression = this.names(input, input.UpdateExpression);
          const clauses = expression
            .split(/\b(SET|REMOVE)\b/i)
            .map((part) => part.trim());
          const set = new Map<string, string>();
          const remove: string[] = [];
          for (let i = 1; i < clauses.length; i += 2) {
            if (clauses[i].toUpperCase() === "SET")
              for (const entry of clauses[i + 1].split(",")) {
                const assignment = /^\s*(\w+)\s*=\s*(:\w+)\s*$/.exec(entry);
                assert.ok(assignment);
                set.set(assignment[1], assignment[2]);
              }
            else
              remove.push(
                ...clauses[i + 1].split(",").map((name) => name.trim()),
              );
          }
          const update = recordOf(expected);
          this.equal(
            [...set.keys()].sort(),
            Object.keys(recordOf(update.set)).sort(),
          );
          this.equal(remove.sort(), listOf(update.remove).map(textOf).sort());
          for (const [attribute, value] of Object.entries(
            recordOf(update.set),
          )) {
            assert.equal(recordOf(value).value_binding, "expires");
            assert.equal(
              BigInt(
                input.ExpressionAttributeValues?.[set.get(attribute) as string]
                  .N as string,
              ),
              integerOf(constraints.expires),
            );
          }
          break;
        }
        case "follow_last_evaluated_key":
          this.checkCursors(group);
          break;
        case "projection": {
          assert.equal(expected, "KEYS_ONLY");
          for (const request of group)
            for (const item of (
              request.returned as { Items?: Record<string, AttributeValue>[] }
            ).Items ?? [])
              assert.ok(
                Object.keys(item).every((key) =>
                  ["aid", "skey", "active_history_seq_nr"].includes(key),
                ),
              );
          break;
        }
        case "include_just_written_history": {
          const commit = all.find((r) => r.phase === "commit");
          assert.ok(commit);
          const written = (commit.input as Request).TransactItems?.find(
            (action) => action.Put?.TableName === this.tables.journal,
          )?.Put?.Item.seq_nr.N;
          assert.ok(written);
          for (const request of all.filter(
            (r) => r.phase === "retention-delete",
          ))
            for (const entries of Object.values(
              (request.input as Request).RequestItems ?? {},
            )) {
              assert.ok(Array.isArray(entries));
              assert.ok(
                entries.every(
                  (entry) =>
                    (
                      entry as {
                        DeleteRequest: { Key: Record<string, AttributeValue> };
                      }
                    ).DeleteRequest.Key.skey.N !== written,
                ),
              );
            }
          break;
        }
        case "retry_unprocessed_items":
        case "initial_batch_sizes": {
          const initial: number[] = [];
          group.forEach((request, index) => {
            const pending =
              index === 0
                ? undefined
                : (group[index - 1].returned as { UnprocessedItems?: unknown })
                    .UnprocessedItems;
            if (
              pending !== undefined &&
              Object.values(pending as Record<string, unknown[]>).some(
                (entries) => entries.length > 0,
              )
            )
              this.equal(
                (request.input as Request).RequestItems,
                pending,
                "retry only unprocessed delete requests",
              );
            else
              initial.push(
                Object.values(
                  (request.input as Request).RequestItems ?? {},
                ).reduce((count, entries) => {
                  assert.ok(Array.isArray(entries));
                  return count + entries.length;
                }, 0),
              );
          });
          if (key === "initial_batch_sizes")
            this.equal(initial, listOf(expected).map(Number));
          break;
        }
        default:
          throw new Error(`unverified request constraint ${key}`);
      }
    }
  }

  private checkCursors(requests: Observation[]): void {
    for (const [index, request] of requests.entries()) {
      const input = request.input as Request;
      const key =
        index === 0
          ? undefined
          : (requests[index - 1].returned as { LastEvaluatedKey?: unknown })
              .LastEvaluatedKey;
      this.equal(
        input.ExclusiveStartKey,
        key,
        "next Query uses actual returned key",
      );
    }
    assert.ok(requests.length > 0);
    const last = requests[requests.length - 1].returned as {
      LastEvaluatedKey?: Record<string, AttributeValue>;
    };
    assert.ok(
      last.LastEvaluatedKey === undefined ||
        Object.keys(last.LastEvaluatedKey).length === 0,
      "all Query pages must finish",
    );
  }

  async checkReadEventPages(requests: Observation[]): Promise<void> {
    const pages = requests.filter(
      (r) => r.phase === "read-events" && r.error === undefined,
    );
    if (pages.length === 0) return;
    this.checkCursors(pages);
    for (const page of pages) {
      assert.equal(
        (page.input as Request).Limit,
        undefined,
        "canonical page cannot use Limit",
      );
      const raw = page.upstream as { Items?: Record<string, AttributeValue>[] };
      const received = page.returned as {
        Items?: Record<string, AttributeValue>[];
        LastEvaluatedKey?: unknown;
      };
      assert.ok(raw && received, "raw and received page evidence required");
      assert.equal(typeof page.wireBody, "string");
      const wire = JSON.parse(page.wireBody as string);
      this.equal(
        wire.ExclusiveStartKey,
        (page.input as Request).ExclusiveStartKey,
        "wire continuation matches SDK input",
      );
      assert.equal(wire.Limit, undefined);
      const rawBytes = (raw.Items ?? []).reduce(
        (sum, item) => sum + journalItemBytes(item),
        0,
      );
      const deliveredBytes = (received.Items ?? []).reduce(
        (sum, item) => sum + journalItemBytes(item),
        0,
      );
      assert.ok(deliveredBytes <= 1048576, "received page obeys 1MiB boundary");
      if (rawBytes <= 1048576)
        this.equal(received, raw, "normal raw page is unchanged");
      else {
        assert.ok(
          (received.Items?.length ?? 0) < (raw.Items?.length ?? 0),
          "oversized page must be shortened",
        );
        const nextItem = raw.Items?.[received.Items?.length ?? 0];
        assert.ok(nextItem);
        assert.ok(
          deliveredBytes + journalItemBytes(nextItem) > 1048576,
          "received prefix must be maximal",
        );
      }
      this.physical = [
        ...this.physical,
        {
          operation: this.operation(),
          rawBytes,
          deliveredBytes,
          input: page.input,
          raw,
          received,
        },
      ];
      this.equal(
        received.Items,
        raw.Items?.slice(0, received.Items?.length),
        "received Items are raw continuous prefix",
      );
      if ((received.Items?.length ?? 0) < (raw.Items?.length ?? 0)) {
        const last = received.Items?.[received.Items.length - 1];
        assert.ok(last);
        this.equal(
          received.LastEvaluatedKey,
          { aid: last.aid, seq_nr: last.seq_nr },
          "corrected page uses real last key",
        );
      }
    }
    const items = pages.flatMap(
      (page) =>
        (page.returned as { Items?: Record<string, AttributeValue>[] }).Items ??
        [],
    );
    assert.equal(
      new Set(items.map((item) => `${item.aid.S}:${item.seq_nr.N}`)).size,
      items.length,
      "read pages contain no duplicate event",
    );
    for (const item of items) {
      const physical = await this.observer.send(
        new GetItemCommand({
          TableName: this.tables.journal,
          Key: { aid: item.aid, seq_nr: item.seq_nr },
          ConsistentRead: true,
        }),
      );
      this.equal(
        item,
        physical.Item,
        "received event equals the independently read physical item",
      );
      this.physical = [
        ...this.physical,
        { operation: this.operation(), journal: physical },
      ];
    }
  }

  async checkLayout(layoutValue: ConformanceJsonValue): Promise<void> {
    for (const declaration of listOf(recordOf(layoutValue).tables)) {
      const expected = recordOf(declaration);
      const name = textOf(expected.name) as keyof Tables;
      const read = await this.observer.send(
        new DescribeTableCommand({ TableName: this.tables[name] }),
      );
      const ttl = await this.observer.send(
        new DescribeTimeToLiveCommand({ TableName: this.tables[name] }),
      );
      this.physical = [...this.physical, { layout: read, ttl }];
      const table = read.Table;
      assert.ok(table);
      const partition = recordOf(expected.partition_key);
      const sort =
        expected.sort_key === null ? undefined : recordOf(expected.sort_key);
      this.equal(
        table.KeySchema?.map((key) => ({
          name: key.AttributeName,
          kind: key.KeyType,
        })).sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
        [
          { name: partition.name, kind: "HASH" },
          ...(sort === undefined ? [] : [{ name: sort.name, kind: "RANGE" }]),
        ],
      );
      const attributeTypes = new Map(
        table.AttributeDefinitions?.map((a) => [
          a.AttributeName,
          a.AttributeType,
        ]),
      );
      assert.equal(attributeTypes.get(textOf(partition.name)), partition.type);
      if (sort !== undefined)
        assert.equal(attributeTypes.get(textOf(sort.name)), sort.type);
      const streams = recordOf(expected.streams);
      assert.equal(
        table.StreamSpecification?.StreamEnabled ?? false,
        streams.enabled,
      );
      assert.equal(
        table.StreamSpecification?.StreamViewType ?? null,
        streams.view_type,
      );
      const indexes = listOf(expected.gsi);
      assert.equal(table.GlobalSecondaryIndexes?.length ?? 0, indexes.length);
      for (const index of indexes) {
        const spec = recordOf(index);
        const actual: GlobalSecondaryIndexDescription | undefined =
          table.GlobalSecondaryIndexes?.find(
            (index) => index.IndexName === this.indexName,
          );
        assert.ok(actual);
        assert.equal(spec.name_binding, "configured-history-index");
        const partition = recordOf(spec.partition_key);
        const sort = recordOf(spec.sort_key);
        this.equal(actual.KeySchema, [
          { AttributeName: partition.name, KeyType: "HASH" },
          { AttributeName: sort.name, KeyType: "RANGE" },
        ]);
        assert.equal(attributeTypes.get(textOf(sort.name)), sort.type);
        assert.equal(actual.Projection?.ProjectionType, spec.projection);
      }
      assert.ok(
        ttl.TimeToLiveDescription?.TimeToLiveStatus === "DISABLED" ||
          ttl.TimeToLiveDescription?.TimeToLiveStatus === undefined,
      );
      if (recordOf(expected.ttl).enabled_when === "retention-mode-ttl") {
        await this.observer.send(
          new UpdateTimeToLiveCommand({
            TableName: this.tables[name],
            TimeToLiveSpecification: {
              AttributeName: textOf(recordOf(expected.ttl).attribute),
              Enabled: true,
            },
          }),
        );
        const enabled = await this.observer.send(
          new DescribeTimeToLiveCommand({ TableName: this.tables[name] }),
        );
        this.physical = [...this.physical, { ttlEnabled: enabled }];
        assert.equal(
          enabled.TimeToLiveDescription?.TimeToLiveStatus,
          "ENABLED",
        );
        assert.equal(
          enabled.TimeToLiveDescription.AttributeName,
          recordOf(expected.ttl).attribute,
        );
      }
    }
  }

  evidence() {
    return { physical: this.physical, sleeps: this.sleeps };
  }
}
