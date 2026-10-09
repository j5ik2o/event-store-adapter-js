import type {
  AttributeValue,
  DynamoDBClient,
  QueryCommandInput,
  QueryCommandOutput,
  TransactWriteItemsCommandInput,
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
  error?: unknown;
  fault?: number;
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

/** 試験専用。実SDKへ委譲した結果と、明示したreplace-requestの適用を別に記録する。 */
export class DynamoDBPersistEventObservation {
  private observations: Observation[] = [];
  private faults: Fault[] = [];
  private queryFaults: QueryFault[] = [];
  private readEvents?: { operation: number; table: string; page: number };

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
        const query = args.input as QueryCommandInput;
        let queryFault: QueryFault | undefined;
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
            queryFault = this.queryFaults[index];
            queryFault.applied += 1;
            observation.fault = index;
            if (queryFault.injection === "replace-request") {
              observation.error = queryFault.cause;
              throw queryFault.cause;
            }
          }
        }
        try {
          const result = await next(args);
          observation.upstream = structuredClone(result.output);
          let output =
            observation.readEvents === undefined
              ? result.output
              : correctReadEventsPage(result.output as QueryCommandOutput);
          if (queryFault?.injection === "replace-response") {
            output = queryFault.replace(output as QueryCommandOutput);
          }
          if (observation.readEvents !== undefined) {
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

  snapshot() {
    return {
      observations: this.observations.map((observation) => ({
        ...observation,
      })),
      faults: this.faults.map((fault) => ({ ...fault })),
      queryFaults: this.queryFaults.map((fault) => ({ ...fault })),
      unapplied: this.faults.flatMap(({ applied }, index) =>
        applied === 0 ? [index] : [],
      ),
      queryUnapplied: this.queryFaults.flatMap(({ applied }, index) =>
        applied === 0 ? [index] : [],
      ),
    };
  }

  assertApplied(): void {
    if (this.snapshot().unapplied.length !== 0)
      throw new Error("registered commit fault was not applied");
    if (this.snapshot().queryUnapplied.length !== 0)
      throw new Error("registered read-events fault was not applied");
  }
}
