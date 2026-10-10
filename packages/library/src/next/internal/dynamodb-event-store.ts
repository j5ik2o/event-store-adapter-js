import { Result } from "../../result";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import type { EventStore } from "../event-store";
import type { EventStoreError } from "../event-store-error";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { createDynamoDBGetEvents } from "./dynamodb-get-events";
import { createDynamoDBGetLatestSnapshot } from "./dynamodb-get-latest-snapshot";
import {
  createDynamoDBPersistEvent,
  createDynamoDBPersistEventAndSnapshot,
} from "./dynamodb-persist-event";
import type { DynamoDBRetentionHooks } from "./dynamodb-retention-hooks";
import {
  type DynamoDBStoreConfiguration,
  ensureDynamoDBStoreConfiguration,
} from "./dynamodb-store-configuration";

/** 設定確定後の4操作を返す内部入口。 */
export async function initializeDynamoDBEventStoreInternal<
  PE = unknown,
  PS = unknown,
>(
  input: DynamoDBEventStoreInput<PE, PS>,
  hooks?: DynamoDBRetentionHooks,
): Promise<
  Result<
    Readonly<{
      settings: Extract<
        ReturnType<typeof validateDynamoDBEventStoreInput<PE, PS>>,
        { type: "ok" }
      >["value"];
      configuration: DynamoDBStoreConfiguration;
      persistEvent: EventStore<PE, PS>["persistEvent"];
      persistEventAndSnapshot: EventStore<PE, PS>["persistEventAndSnapshot"];
      getEventsByIdSinceSeqNr: EventStore<PE, PS>["getEventsByIdSinceSeqNr"];
      getLatestSnapshotById: EventStore<PE, PS>["getLatestSnapshotById"];
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
      persistEvent: createDynamoDBPersistEvent(settings.value, hooks),
      persistEventAndSnapshot: createDynamoDBPersistEventAndSnapshot(
        settings.value,
        hooks,
      ),
      getEventsByIdSinceSeqNr: createDynamoDBGetEvents(settings.value),
      getLatestSnapshotById: createDynamoDBGetLatestSnapshot(
        settings.value,
        hooks?.sleep,
      ),
    }),
  );
}
