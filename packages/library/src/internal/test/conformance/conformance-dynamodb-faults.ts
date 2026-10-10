import assert from "node:assert/strict";
import {
  type AttributeValue,
  type BatchGetItemCommandInput,
  type BatchGetItemCommandOutput,
  type DynamoDBClient,
  DynamoDBServiceException,
  GetItemCommand,
  PutItemCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
  TransactionCanceledException,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBPersistEventObservation } from "../dynamodb-persist-event-observation";
import { deferDynamoDBRequestedKeys } from "../dynamodb-unprocessed-keys";
import { encodeDeclaredItem } from "./conformance-dynamodb-items";
import type { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { integerOf, listOf, recordOf, textOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";

type Tables = Readonly<{ journal: string; snapshot: string; head: string }>;
type Taken = NonNullable<ReturnType<ConformanceFaultRegistry["take"]>>;

export class ConformanceDynamoDBFaults {
  private operation = 0;
  private phaseCounts = new Map<string, number>();
  private pending?: Taken;
  private history?: {
    fault: Taken;
    pages: readonly ConformanceJsonValue[];
    page: number;
    nextKey?: Record<string, AttributeValue>;
  };
  private capturedHead?: Record<string, AttributeValue>;
  private writtenSeqNr?: bigint;
  private physical: unknown[] = [];

  constructor(
    private readonly registry: ConformanceFaultRegistry,
    private readonly observer: DynamoDBClient,
    private readonly tables: Tables,
    private readonly indexName: string,
    private readonly observation: DynamoDBPersistEventObservation,
    private readonly interleave: (
      operation: ConformanceJsonValue,
    ) => Promise<void>,
  ) {}

  begin(operation: number): void {
    this.operation = operation;
    this.phaseCounts.clear();
    this.registry.begin(operation);
    this.observation.beginRetention(
      this.tables.snapshot,
      this.indexName,
      operation,
    );
    this.observation.beginReadEvents(this.tables.journal, operation);
    this.observation.beginReadSnapshot(this.tables, operation);
  }

  phase(command: string | undefined, input: unknown): string {
    const request = input as { TableName?: string; IndexName?: string };
    if (command === "TransactWriteItemsCommand")
      return (input as TransactWriteItemsCommandInput).TransactItems?.some(
        (action) => action.Put?.Item?.aid?.S === "__config__",
      )
        ? "configuration-create"
        : "commit";
    if (command === "BatchGetItemCommand")
      return Object.values(
        (input as BatchGetItemCommandInput).RequestItems ?? {},
      ).some((request) =>
        request.Keys?.some((key) => key.aid?.S === "__config__"),
      )
        ? "configuration-read"
        : "read-snapshot";
    if (
      command === "QueryCommand" &&
      request.TableName === this.tables.journal &&
      request.IndexName === undefined
    )
      return "read-events";
    if (
      command === "QueryCommand" &&
      request.TableName === this.tables.snapshot &&
      request.IndexName === this.indexName
    )
      return "retention-query";
    if (command === "BatchWriteItemCommand") return "retention-delete";
    if (
      command === "UpdateItemCommand" &&
      request.TableName === this.tables.snapshot
    )
      return "retention-mark";
    throw new Error(`unexpected store command ${command}`);
  }

  context(command: string | undefined, input: unknown) {
    return { operation: this.operation, phase: this.phase(command, input) };
  }

  async before(command: string | undefined, input: unknown): Promise<void> {
    const phase = this.phase(command, input);
    const request = (this.phaseCounts.get(phase) ?? 0) + 1;
    this.phaseCounts.set(phase, request);
    if (phase === "commit") {
      const journal = (
        input as TransactWriteItemsCommandInput
      ).TransactItems?.find(
        (action) => action.Put?.TableName === this.tables.journal,
      )?.Put?.Item;
      assert.ok(journal?.seq_nr.N);
      this.writtenSeqNr = BigInt(journal.seq_nr.N);
    }
    if (phase === "retention-query" && this.history !== undefined) {
      assert.deepEqual(
        (input as QueryCommandInput).ExclusiveStartKey,
        this.history.nextKey,
        "history page cursor",
      );
      return;
    }
    const fault = this.registry.take(phase);
    if (fault === undefined) return;
    this.pending = fault;
    const details = recordOf(fault.declaration.details);
    if (details.install_items !== undefined) {
      for (const item of listOf(details.install_items)) {
        const table = textOf(recordOf(item).table) as keyof Tables;
        await this.observer.send(
          new PutItemCommand({
            TableName: this.tables[table],
            Item: encodeDeclaredItem(item),
          }),
        );
      }
    }
    if (fault.declaration.kind === "read-interleave") {
      const batch = input as BatchGetItemCommandInput;
      const key = batch.RequestItems?.[this.tables.head]?.Keys?.[0];
      assert.ok(key, "interleave must request head");
      const captured = await this.observer.send(
        new GetItemCommand({
          TableName: this.tables.head,
          Key: key,
          ConsistentRead: true,
        }),
      );
      this.capturedHead = captured.Item;
      assert.ok(this.capturedHead, "interleave needs stored head");
      this.physical = [...this.physical, { captureHead: captured }];
      await this.interleave(details.interleaved_operation);
    }
    if (
      fault.declaration.kind === "sdk-response" &&
      details.unprocessed_first_n !== undefined
    ) {
      this.observation.deferRetentionDeletes({
        operation: this.operation,
        table: this.tables.snapshot,
        request,
        pendingCount: Number(integerOf(details.unprocessed_first_n)),
        observer: this.observer,
      });
      return;
    }
    if (fault.declaration.injection === "replace-request")
      this.throwDeclared(fault, input);
  }

  private throwDeclared(fault: Taken, input: unknown): never {
    const details = recordOf(fault.declaration.details);
    let cause: Error;
    if (fault.declaration.kind === "storage-error")
      cause = new Error(textOf(details.message));
    else if (details.code === "TransactionCanceledException") {
      const actions = (input as TransactWriteItemsCommandInput).TransactItems;
      assert.ok(actions);
      const declarations = listOf(details.cancellation_reasons).map(recordOf);
      const targets = actions.map((action) => {
        const write = action.Put ?? action.Update;
        assert.ok(write);
        const table = (Object.keys(this.tables) as (keyof Tables)[]).find(
          (name) => this.tables[name] === write.TableName,
        );
        assert.ok(table);
        if (this.operation === 0) return `configuration:${table}`;
        if (table !== "snapshot") return table;
        return action.Put?.Item?.skey?.N === "0"
          ? "current-snapshot"
          : "history-snapshot";
      });
      assert.deepEqual(
        [...targets].sort(),
        declarations.map((r) => textOf(r.target)).sort(),
        "cancellation targets must match real actions",
      );
      cause = new TransactionCanceledException({
        $metadata: {},
        message:
          typeof details.message === "string"
            ? details.message
            : "declared configuration race",
        CancellationReasons: targets.map((target) => {
          const reason = declarations.find((r) => r.target === target);
          assert.ok(reason);
          return {
            Code: textOf(reason.code),
            ...(reason.old_head_seq_nr === undefined ||
            reason.old_head_seq_nr === null
              ? {}
              : {
                  Item: {
                    seq_nr: { N: integerOf(reason.old_head_seq_nr).toString() },
                  },
                }),
          };
        }),
      });
    } else {
      assert.equal(fault.declaration.kind, "sdk-error");
      cause = new DynamoDBServiceException({
        name: textOf(details.code),
        $fault: "client",
        $metadata: {},
        message: textOf(details.message),
      });
    }
    this.registry.applied(fault.index);
    this.pending = undefined;
    throw cause;
  }

  async after(
    command: string | undefined,
    input: unknown,
    output: unknown,
  ): Promise<unknown> {
    const phase = this.phase(command, input);
    const fault = this.pending;
    this.pending = undefined;
    if (
      phase === "retention-query" &&
      (this.history !== undefined ||
        (fault !== undefined &&
          recordOf(fault.declaration.details).history_pages !== undefined))
    ) {
      if (this.history === undefined) {
        assert.ok(fault);
        const details = recordOf(fault.declaration.details);
        const pages = listOf(details.history_pages);
        if (details.omit_just_written_history === true)
          assert.ok(
            !pages
              .flatMap(listOf)
              .map(integerOf)
              .includes(this.writtenSeqNr as bigint),
            "omit plan contains just-written history",
          );
        this.history = { fault, pages, page: 0 };
      }
      const plan = this.history;
      const query = input as QueryCommandInput;
      const aid = query.ExpressionAttributeValues?.[":aid"];
      assert.ok(aid);
      const items: Record<string, AttributeValue>[] = [];
      for (const value of listOf(plan.pages[plan.page])) {
        const read = await this.observer.send(
          new GetItemCommand({
            TableName: this.tables.snapshot,
            Key: { aid, skey: { N: integerOf(value).toString() } },
            ConsistentRead: true,
          }),
        );
        assert.ok(read.Item, "history page must refer to a stored item");
        this.physical = [...this.physical, { historySource: read }];
        items.push({
          aid: read.Item.aid,
          skey: read.Item.skey,
          ...(read.Item.active_history_seq_nr === undefined
            ? {}
            : { active_history_seq_nr: read.Item.active_history_seq_nr }),
        });
      }
      const last = items[items.length - 1];
      const nextKey =
        plan.page + 1 < plan.pages.length ? { ...last } : undefined;
      assert.ok(
        plan.page + 1 === plan.pages.length || last,
        "nonterminal history page needs real last key",
      );
      const response: QueryCommandOutput = {
        ...(output as QueryCommandOutput),
        Items: items,
        Count: items.length,
        ScannedCount: items.length,
        LastEvaluatedKey: nextKey,
      };
      if (plan.page + 1 === plan.pages.length) {
        this.registry.applied(plan.fault.index);
        this.history = undefined;
      } else this.history = { ...plan, page: plan.page + 1, nextKey };
      return response;
    }
    if (fault === undefined) return output;
    const details = recordOf(fault.declaration.details);
    let returned = output;
    if (fault.declaration.kind === "read-interleave") {
      const batch = output as BatchGetItemCommandOutput;
      returned = {
        ...batch,
        Responses: {
          ...batch.Responses,
          [this.tables.head]: [this.capturedHead],
        },
      };
    } else if (details.unprocessed_keys !== undefined) {
      const request = input as BatchGetItemCommandInput;
      const names = listOf(details.unprocessed_keys).map(
        (key) => textOf(key).split(":")[0] as keyof Tables,
      );
      const tables = names.map((name) => this.tables[name]);
      returned = deferDynamoDBRequestedKeys(
        request,
        output as BatchGetItemCommandOutput,
        tables,
      );
      for (const [name, source] of Object.entries(
        recordOf(details.responses),
      )) {
        assert.ok(source === "seed-config" || source === "stored-head");
        assert.ok(
          request.RequestItems?.[this.tables[name as keyof Tables]]?.Keys
            ?.length,
          "response plan includes unrequested table",
        );
      }
      assert.deepEqual(
        Object.keys(
          (returned as BatchGetItemCommandOutput).Responses ?? {},
        ).sort(),
        Object.keys(recordOf(details.responses))
          .map((name) => this.tables[name as keyof Tables])
          .sort(),
        "processed response tables",
      );
    } else if (details.unprocessed_first_n === undefined)
      throw new Error("unsupported SDK response declaration");
    this.registry.applied(fault.index);
    return returned;
  }

  finish(operation: number): void {
    assert.equal(this.history, undefined, "history plan must finish all pages");
    this.registry.finish(operation);
  }
  evidence() {
    return {
      faults: this.registry.snapshot(),
      physical: this.physical,
      requests: this.observation.snapshot(),
    };
  }
}
