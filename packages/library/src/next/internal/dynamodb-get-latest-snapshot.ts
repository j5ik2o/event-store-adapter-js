import type { EventStore } from "../event-store";
import { readDynamoDBBatch } from "./dynamodb-batch-get";
import type { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { restoreDynamoDBLatestSnapshot } from "./dynamodb-latest-snapshot-restore";
import { validateAggregateId } from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateDynamoDBEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

export function createDynamoDBGetLatestSnapshot<PE, PS>(
  settings: Settings<PE, PS>,
  sleep?: (ms: number) => Promise<void>,
): EventStore<PE, PS>["getLatestSnapshotById"] {
  return async (aggregateId) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;
    const read = await readDynamoDBBatch(
      settings,
      {
        [settings.tables.head]: {
          Keys: [{ aid: { S: aid } }],
          ConsistentRead: true,
        },
        [settings.tables.snapshot]: {
          Keys: [{ aid: { S: aid }, skey: { N: "0" } }],
          ConsistentRead: true,
        },
      },
      "latest snapshot read",
      sleep,
    );
    if (read.type === "err") return read;
    return restoreDynamoDBLatestSnapshot(
      read.value.get(settings.tables.head),
      read.value.get(settings.tables.snapshot),
      validatedId.value,
      settings.snapshotSerializer,
    );
  };
}
