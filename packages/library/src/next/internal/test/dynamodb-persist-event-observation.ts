import {
  type AttributeValue,
  type BatchGetItemCommandInput,
  type BatchGetItemCommandOutput,
  BatchWriteItemCommand,
  type BatchWriteItemCommandInput,
  type BatchWriteItemCommandOutput,
  type DynamoDBClient,
  type QueryCommandInput,
  type QueryCommandOutput,
  type TransactWriteItemsCommandInput,
  type UpdateItemCommandInput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";

function journalItemBytes(item: Record<string, AttributeValue>): number {
  return Object.entries(item).reduce(
    (sum, [name, value]) =>
      sum +
      Buffer.byteLength(name, "utf8") +
      (value.B !== undefined
        ? value.B.byteLength
        : Buffer.byteLength(value.S ?? (value.N as string), "utf8")),
    0,
  );
}

/** 元Local応答の実Itemsだけから1MiB以下の連続prefixを届ける。 */
function correctReadEventsPage(output: QueryCommandOutput): QueryCommandOutput {
  if (output.Items === undefined) return output;
  let bytes = 0;
  for (let n = 0; n < output.Items.length; n += 1) {
    bytes += journalItemBytes(output.Items[n]);
    if (bytes > 1048576) {
      const items = output.Items.slice(0, n);
      const last = items[items.length - 1];
      return {
        ...output,
        Items: items,
        Count: items.length,
        ScannedCount: items.length,
        LastEvaluatedKey: { aid: last.aid, seq_nr: last.seq_nr },
      };
    }
  }
  return output;
}

type Observation = {
  commandName: string | undefined;
  input: unknown;
  wireBody: unknown;
  upstream?: unknown;
  returned?: unknown;
  readEvents?: { operation: number; page: number; table: string };
  readSnapshot?: {
    operation: number;
    request: number;
    tables: readonly string[];
  };
  error?: unknown;
  fault?: number;
  retention?: {
    operation: number;
    stage: RetentionStage;
    request: number;
    table: string;
  };
  delegatedDelete?: BatchWriteItemCommandInput;
};
type Fault = { cause: unknown; applied: number };
type QueryFault = {
  operation: number;
  table: string;
  page: number;
  applied: number;
} & (
  | { injection: "replace-request"; cause: unknown }
  | {
      injection: "replace-response";
      replace: (output: QueryCommandOutput) => QueryCommandOutput;
    }
);
type SnapshotFault = {
  operation: number;
  table: string;
  request: number;
  applied: number;
} & (
  | { injection: "replace-request"; cause: unknown }
  | {
      injection: "replace-response";
      replace: (
        output: BatchGetItemCommandOutput,
        input: BatchGetItemCommandInput,
      ) => BatchGetItemCommandOutput;
    }
);

type RetentionStage = "query" | "delete" | "ttl";
type RetentionOutput =
  | QueryCommandOutput
  | BatchWriteItemCommandOutput
  | UpdateItemCommandOutput;
type RetentionFault = {
  operation: number;
  table: string;
  stage: RetentionStage;
  request: number;
  applied: number;
} & (
  | { injection: "replace-request"; cause: unknown }
  | {
      injection: "replace-response";
      replace: (output: RetentionOutput) => RetentionOutput;
    }
  | {
      injection: "partial-delete";
      pendingCount: number;
      observer: DynamoDBClient;
    }
);

/** 試験専用。実SDKへ委譲した結果と、明示したreplace-requestの適用を別に記録する。 */
export class DynamoDBPersistEventObservation {
  private observations: Observation[] = [];
  private faults: Fault[] = [];
  private queryFaults: QueryFault[] = [];
  private readEvents?: { operation: number; table: string; page: number };
  private snapshotFaults: SnapshotFault[] = [];
  private retentionFaults: RetentionFault[] = [];
  private retention?: {
    operation: number;
    table: string;
    indexName: string;
    requests: Record<RetentionStage, number>;
  };
  private readSnapshot?: {
    operation: number;
    tables: readonly string[];
    request: number;
    beforeSend?: () => Promise<void>;
  };

  constructor(client: DynamoDBClient, beforeSend?: () => Promise<void>) {
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const request = args.request as { body?: unknown };
        const observation: Observation = {
          commandName: context.commandName,
          input: structuredClone(args.input),
          wireBody:
            request.body instanceof Uint8Array
              ? Buffer.from(request.body).toString("utf8")
              : request.body,
        };
        this.observations = [...this.observations, observation];
        const items = (args.input as TransactWriteItemsCommandInput)
          .TransactItems;
        const commit =
          context.commandName === "TransactWriteItemsCommand" &&
          items !== undefined &&
          items.length >= 2 &&
          items.length <= 4 &&
          items[0].Put?.Item?.aid?.S !== "__config__";
        if (commit) {
          const index = this.faults.findIndex(({ applied }) => applied === 0);
          if (index !== -1) {
            const fault = this.faults[index];
            fault.applied += 1;
            observation.fault = index;
            observation.error = fault.cause;
            throw fault.cause;
          }
          if (beforeSend !== undefined) await beforeSend();
        }
        let retentionFault:
          | { index: number; fault: RetentionFault }
          | undefined;
        const retention = this.retention;
        if (retention !== undefined) {
          const queryInput = args.input as QueryCommandInput;
          const deleteInput = args.input as BatchWriteItemCommandInput;
          const updateInput = args.input as UpdateItemCommandInput;
          const stage =
            context.commandName === "QueryCommand" &&
            queryInput.TableName === retention.table &&
            queryInput.IndexName === retention.indexName
              ? "query"
              : context.commandName === "BatchWriteItemCommand" &&
                  Object.keys(deleteInput.RequestItems ?? {}).includes(
                    retention.table,
                  )
                ? "delete"
                : context.commandName === "UpdateItemCommand" &&
                    updateInput.TableName === retention.table
                  ? "ttl"
                  : undefined;
          if (stage !== undefined) {
            const request = retention.requests[stage] + 1;
            this.retention = {
              ...retention,
              requests: { ...retention.requests, [stage]: request },
            };
            observation.retention = {
              operation: retention.operation,
              table: retention.table,
              stage,
              request,
            };
            const index = this.retentionFaults.findIndex(
              (fault) =>
                fault.applied === 0 &&
                fault.operation === retention.operation &&
                fault.table === retention.table &&
                fault.stage === stage &&
                fault.request === request,
            );
            if (index !== -1) {
              const fault = this.retentionFaults[index];
              retentionFault = { index, fault };
              observation.fault = index;
              if (fault.injection === "replace-request") {
                this.markRetentionFaultApplied(index);
                observation.error = fault.cause;
                throw fault.cause;
              }
              if (fault.injection === "partial-delete") {
                try {
                  const requests = deleteInput.RequestItems?.[retention.table];
                  if (requests === undefined)
                    throw new Error(
                      "partial-delete fault requires delete requests",
                    );
                  const pending = requests.slice(0, fault.pendingCount);
                  const processed = requests.slice(fault.pendingCount);
                  let upstream: BatchWriteItemCommandOutput | undefined;
                  if (processed.length > 0) {
                    const delegated = {
                      RequestItems: { [retention.table]: processed },
                    };
                    observation.delegatedDelete = structuredClone(delegated);
                    upstream = await fault.observer.send(
                      new BatchWriteItemCommand(delegated),
                    );
                    observation.upstream = structuredClone(upstream);
                  }
                  const output: BatchWriteItemCommandOutput = {
                    ...upstream,
                    $metadata: upstream?.$metadata ?? {},
                    UnprocessedItems: {
                      ...upstream?.UnprocessedItems,
                      [retention.table]: [
                        ...pending,
                        ...(Object.entries(
                          upstream?.UnprocessedItems ?? {},
                        ).find(([table]) => table === retention.table)?.[1] ??
                          []),
                      ],
                    },
                  };
                  observation.returned = structuredClone(output);
                  this.markRetentionFaultApplied(index);
                  return {
                    response: { statusCode: 200, headers: {}, body: "" },
                    output,
                  };
                } catch (cause) {
                  observation.error = cause;
                  throw cause;
                }
              }
            }
          }
        }
        const query = args.input as QueryCommandInput;
        let queryFault: { index: number; fault: QueryFault } | undefined;
        if (
          context.commandName === "QueryCommand" &&
          query.IndexName === undefined &&
          this.readEvents !== undefined &&
          query.TableName === this.readEvents.table
        ) {
          this.readEvents = {
            ...this.readEvents,
            page: this.readEvents.page + 1,
          };
          observation.readEvents = { ...this.readEvents };
          const { operation, table, page } = this.readEvents;
          const index = this.queryFaults.findIndex(
            (fault) =>
              fault.applied === 0 &&
              fault.operation === operation &&
              fault.table === table &&
              fault.page === page,
          );
          if (index !== -1) {
            const fault = this.queryFaults[index];
            queryFault = { index, fault };
            observation.fault = index;
            if (fault.injection === "replace-request") {
              this.markQueryFaultApplied(index);
              observation.error = fault.cause;
              throw fault.cause;
            }
          }
        }
        const batch = args.input as BatchGetItemCommandInput;
        let snapshotFault: { index: number; fault: SnapshotFault } | undefined;
        const requested = Object.entries(batch.RequestItems ?? {});
        const snapshotRead = this.readSnapshot;
        if (
          context.commandName === "BatchGetItemCommand" &&
          snapshotRead !== undefined &&
          requested.length > 0 &&
          requested.every(
            ([table, request]) =>
              snapshotRead.tables.includes(table) &&
              request.Keys !== undefined &&
              request.Keys.length > 0 &&
              request.Keys.every((key) => key.aid?.S !== "__config__"),
          )
        ) {
          this.readSnapshot = {
            ...snapshotRead,
            request: snapshotRead.request + 1,
          };
          const {
            operation,
            request,
            tables,
            beforeSend: gate,
          } = this.readSnapshot;
          observation.readSnapshot = {
            operation,
            request,
            tables: [...tables],
          };
          const index = this.snapshotFaults.findIndex(
            (fault) =>
              fault.applied === 0 &&
              fault.operation === operation &&
              fault.request === request &&
              requested.some(([table]) => table === fault.table),
          );
          if (index !== -1) {
            const fault = this.snapshotFaults[index];
            snapshotFault = { index, fault };
            observation.fault = index;
            if (fault.injection === "replace-request") {
              this.markSnapshotFaultApplied(index);
              observation.error = fault.cause;
              throw fault.cause;
            }
          }
          if (gate !== undefined) await gate();
        }
        try {
          const result = await next(args);
          observation.upstream = structuredClone(result.output);
          let output =
            observation.readEvents === undefined
              ? result.output
              : correctReadEventsPage(result.output as QueryCommandOutput);
          if (queryFault?.fault.injection === "replace-response") {
            output = queryFault.fault.replace(output as QueryCommandOutput);
            this.markQueryFaultApplied(queryFault.index);
          }
          if (snapshotFault?.fault.injection === "replace-response") {
            output = snapshotFault.fault.replace(
              output as BatchGetItemCommandOutput,
              batch,
            );
            this.markSnapshotFaultApplied(snapshotFault.index);
          }
          if (retentionFault?.fault.injection === "replace-response") {
            output = retentionFault.fault.replace(output as RetentionOutput);
            this.markRetentionFaultApplied(retentionFault.index);
          }
          if (
            observation.readEvents !== undefined ||
            observation.readSnapshot !== undefined ||
            observation.retention !== undefined
          ) {
            observation.returned = structuredClone(output);
            return { ...result, output };
          }
          return result;
        } catch (cause) {
          observation.error = cause;
          throw cause;
        }
      },
      { step: "build", name: "persistEventObservation", priority: "high" },
    );
  }

  private markQueryFaultApplied(index: number): void {
    this.queryFaults = this.queryFaults.map((fault, position) =>
      position === index ? { ...fault, applied: fault.applied + 1 } : fault,
    );
  }

  private markSnapshotFaultApplied(index: number): void {
    this.snapshotFaults = this.snapshotFaults.map((fault, position) =>
      position === index ? { ...fault, applied: fault.applied + 1 } : fault,
    );
  }

  private markRetentionFaultApplied(index: number): void {
    this.retentionFaults = this.retentionFaults.map((fault, position) =>
      position === index ? { ...fault, applied: fault.applied + 1 } : fault,
    );
  }

  beginRetention(table: string, indexName: string, operation: number): void {
    this.retention = {
      table,
      indexName,
      operation,
      requests: { query: 0, delete: 0, ttl: 0 },
    };
  }

  failRetention(
    input: Readonly<{
      operation: number;
      table: string;
      stage: RetentionStage;
      request: number;
      cause: unknown;
    }>,
  ): void {
    this.retentionFaults = [
      ...this.retentionFaults,
      { ...input, injection: "replace-request", applied: 0 },
    ];
  }

  replaceRetentionQuery(
    input: Readonly<{
      operation: number;
      table: string;
      request: number;
      replace: (output: QueryCommandOutput) => QueryCommandOutput;
    }>,
  ): void {
    this.retentionFaults = [
      ...this.retentionFaults,
      {
        ...input,
        stage: "query",
        injection: "replace-response",
        applied: 0,
        replace: (output) => input.replace(output as QueryCommandOutput),
      },
    ];
  }

  deferRetentionDeletes(
    input: Readonly<{
      operation: number;
      table: string;
      request: number;
      pendingCount: number;
      observer: DynamoDBClient;
    }>,
  ): void {
    this.retentionFaults = [
      ...this.retentionFaults,
      { ...input, stage: "delete", injection: "partial-delete", applied: 0 },
    ];
  }

  failNext(cause: unknown): void {
    this.faults = [...this.faults, { cause, applied: 0 }];
  }

  beginReadEvents(table: string, operation: number): void {
    this.readEvents = { table, operation, page: 0 };
  }

  failReadEvents(
    input: Readonly<{
      operation: number;
      table: string;
      page: number;
      cause: unknown;
    }>,
  ): void {
    this.queryFaults = [
      ...this.queryFaults,
      { ...input, injection: "replace-request", applied: 0 },
    ];
  }

  replaceReadEvents(
    input: Readonly<{
      operation: number;
      table: string;
      page: number;
      replace: (output: QueryCommandOutput) => QueryCommandOutput;
    }>,
  ): void {
    this.queryFaults = [
      ...this.queryFaults,
      { ...input, injection: "replace-response", applied: 0 },
    ];
  }

  beginReadSnapshot(
    tables: Readonly<{ head: string; snapshot: string }>,
    operation: number,
    beforeSend?: () => Promise<void>,
  ): void {
    this.readSnapshot = {
      tables: [tables.head, tables.snapshot],
      operation,
      request: 0,
      beforeSend,
    };
  }

  failReadSnapshot(
    input: Readonly<{
      operation: number;
      table: string;
      request: number;
      cause: unknown;
    }>,
  ): void {
    this.snapshotFaults = [
      ...this.snapshotFaults,
      { ...input, injection: "replace-request", applied: 0 },
    ];
  }

  replaceReadSnapshot(
    input: Readonly<{
      operation: number;
      table: string;
      request: number;
      replace: (
        output: BatchGetItemCommandOutput,
        input: BatchGetItemCommandInput,
      ) => BatchGetItemCommandOutput;
    }>,
  ): void {
    this.snapshotFaults = [
      ...this.snapshotFaults,
      { ...input, injection: "replace-response", applied: 0 },
    ];
  }

  snapshot() {
    return {
      observations: this.observations.map((observation) => ({
        ...observation,
      })),
      faults: this.faults.map((fault) => ({ ...fault })),
      queryFaults: this.queryFaults.map((fault) => ({ ...fault })),
      snapshotFaults: this.snapshotFaults.map((fault) => ({ ...fault })),
      retentionFaults: this.retentionFaults.map(({ ...fault }) =>
        fault.injection === "partial-delete"
          ? { ...fault, observer: undefined }
          : fault,
      ),
      unapplied: this.faults.flatMap(({ applied }, index) =>
        applied === 0 ? [index] : [],
      ),
      queryUnapplied: this.queryFaults.flatMap(({ applied }, index) =>
        applied === 0 ? [index] : [],
      ),
      snapshotUnapplied: this.snapshotFaults.flatMap(({ applied }, index) =>
        applied === 0 ? [index] : [],
      ),
      retentionUnapplied: this.retentionFaults.flatMap(({ applied }, index) =>
        applied === 0 ? [index] : [],
      ),
    };
  }

  assertApplied(): void {
    if (this.snapshot().unapplied.length !== 0)
      throw new Error("registered commit fault was not applied");
    if (this.snapshot().queryUnapplied.length !== 0)
      throw new Error("registered read-events fault was not applied");
    if (this.snapshot().snapshotUnapplied.length !== 0)
      throw new Error("registered read-snapshot fault was not applied");
    if (this.snapshot().retentionUnapplied.length !== 0)
      throw new Error("registered retention fault was not applied");
  }
}
