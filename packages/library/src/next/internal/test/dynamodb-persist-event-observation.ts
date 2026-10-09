import type {
  DynamoDBClient,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";

type Observation = {
  commandName: string | undefined;
  input: unknown;
  wireBody: unknown;
  upstream?: unknown;
  error?: unknown;
  fault?: number;
};
type Fault = { cause: unknown; applied: number };

/** 試験専用。実SDKへ委譲した結果と、明示したreplace-requestの適用を別に記録する。 */
export class DynamoDBPersistEventObservation {
  private observations: Observation[] = [];
  private faults: Fault[] = [];

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
        try {
          const result = await next(args);
          observation.upstream = structuredClone(result.output);
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

  snapshot() {
    return {
      observations: this.observations.map((observation) => ({
        ...observation,
      })),
      faults: this.faults.map((fault) => ({ ...fault })),
      unapplied: this.faults.flatMap(({ applied }, index) =>
        applied === 0 ? [index] : [],
      ),
    };
  }

  assertApplied(): void {
    if (this.snapshot().unapplied.length !== 0)
      throw new Error("registered commit fault was not applied");
  }
}
