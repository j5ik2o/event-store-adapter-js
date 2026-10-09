import { Result } from "../../result";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import type { EventStoreError } from "../event-store-error";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import {
  type DynamoDBStoreConfiguration,
  ensureDynamoDBStoreConfiguration,
} from "./dynamodb-store-configuration";

/** 設定確定までの内部生成入口。製品4操作を持つEventStoreは返さない。 */
export async function initializeDynamoDBEventStoreInternal<
  PE = unknown,
  PS = unknown,
>(
  input: DynamoDBEventStoreInput<PE, PS>,
  hooks?: Readonly<{ sleep?: (ms: number) => Promise<void> }>,
): Promise<
  Result<
    Readonly<{
      settings: Extract<
        ReturnType<typeof validateDynamoDBEventStoreInput<PE, PS>>,
        { type: "ok" }
      >["value"];
      configuration: DynamoDBStoreConfiguration;
    }>,
    EventStoreError
  >
> {
  const settings = validateDynamoDBEventStoreInput(input);
  if (settings.type === "err") return settings;
  const configuration = await ensureDynamoDBStoreConfiguration(
    settings.value,
    hooks?.sleep,
  );
  if (configuration.type === "err") return configuration;
  return Result.ok(
    Object.freeze({
      settings: settings.value,
      configuration: configuration.value,
    }),
  );
}
