import { Result } from "../../result";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import type { EventStore } from "../event-store";
import type { EventStoreError } from "../event-store-error";
import { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { createDynamoDBGetEvents } from "./dynamodb-get-events";
import {
  createDynamoDBPersistEvent,
  createDynamoDBPersistEventAndSnapshot,
} from "./dynamodb-persist-event";
import {
  type DynamoDBStoreConfiguration,
  ensureDynamoDBStoreConfiguration,
} from "./dynamodb-store-configuration";

/** 設定確定後の両追記とイベント読取を返す内部入口。最新snapshotの接続は後続。 */
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
      persistEvent: EventStore<PE, PS>["persistEvent"];
      persistEventAndSnapshot: EventStore<PE, PS>["persistEventAndSnapshot"];
      getEventsByIdSinceSeqNr: EventStore<PE, PS>["getEventsByIdSinceSeqNr"];
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
      persistEvent: createDynamoDBPersistEvent(settings.value),
      persistEventAndSnapshot: createDynamoDBPersistEventAndSnapshot(
        settings.value,
      ),
      getEventsByIdSinceSeqNr: createDynamoDBGetEvents(settings.value),
    }),
  );
}
