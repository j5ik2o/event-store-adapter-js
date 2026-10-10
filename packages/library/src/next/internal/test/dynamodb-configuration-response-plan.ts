import type {
  BatchGetItemCommandInput,
  BatchGetItemCommandOutput,
  DynamoDBClient,
  ServiceInputTypes,
  ServiceOutputTypes,
} from "@aws-sdk/client-dynamodb";
import { deferDynamoDBRequestedKeys } from "./dynamodb-unprocessed-keys";

type ReadPlan = Readonly<{
  tables: readonly string[];
  times: number;
  applied: number;
}>;
type Observation = Readonly<{
  commandName: string;
  input: ServiceInputTypes;
  wireBody: string;
  upstream?: ServiceOutputTypes;
  returned?: ServiceOutputTypes;
  error?: unknown;
}>;

/** 実要求とnextの実応答を記録し、指定表の要求鍵だけを未処理へ移す。 */
export class DynamoDBConfigurationResponsePlan {
  private plans: ReadPlan[] = [];
  private observations: Observation[] = [];

  constructor(
    client: DynamoDBClient,
    hooks?: Readonly<{
      beforeSend?: (commandName: string) => Promise<void>;
      onError?: (commandName: string, cause: unknown) => Promise<void>;
    }>,
  ) {
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const commandName = context.commandName;
        if (
          commandName !== "BatchGetItemCommand" &&
          commandName !== "TransactWriteItemsCommand"
        )
          return next(args);
        const body = (args.request as { body: string | Uint8Array }).body;
        const observation = {
          commandName,
          input: structuredClone(args.input),
          wireBody:
            typeof body === "string"
              ? body
              : Buffer.from(body).toString("utf8"),
        };
        await hooks?.beforeSend?.(commandName);
        try {
          const response = await next(args);
          const upstream = structuredClone(response.output);
          const returned =
            commandName === "BatchGetItemCommand"
              ? this.deferRequestedKeys(
                  args.input as BatchGetItemCommandInput,
                  response.output as BatchGetItemCommandOutput,
                )
              : response.output;
          this.observations = [
            ...this.observations,
            { ...observation, upstream, returned: structuredClone(returned) },
          ];
          return { ...response, output: returned };
        } catch (cause) {
          this.observations = [
            ...this.observations,
            { ...observation, error: cause },
          ];
          await hooks?.onError?.(commandName, cause);
          throw cause;
        }
      },
      { step: "build", name: "dynamodbConfigurationObservations" },
    );
  }

  deferTables(tables: readonly string[], times: number): void {
    this.plans = [...this.plans, { tables: [...tables], times, applied: 0 }];
  }

  private deferRequestedKeys(
    input: BatchGetItemCommandInput,
    upstream: BatchGetItemCommandOutput,
  ): BatchGetItemCommandOutput {
    const index = this.plans.findIndex((plan) => plan.applied < plan.times);
    if (index < 0) return upstream;
    const plan = this.plans[index];
    const returned = deferDynamoDBRequestedKeys(input, upstream, plan.tables);
    if (returned === upstream) return upstream;
    this.plans = this.plans.map((entry, position) =>
      position === index ? { ...entry, applied: entry.applied + 1 } : entry,
    );
    return returned;
  }

  snapshot() {
    return Object.freeze({
      observations: [...this.observations],
      plans: structuredClone(this.plans),
    });
  }

  assertApplied(): void {
    if (this.plans.some((plan) => plan.applied !== plan.times)) {
      throw new Error(
        "configuration response plan did not apply the registered number of times",
      );
    }
  }
}
