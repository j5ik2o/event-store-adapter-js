import { type AttributeValue, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { restoreDynamoDBEventEnvelope } from "./dynamodb-event-envelope-restore";
import type { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { validateSeqNr } from "./seq-nr-validation";
import { validateAggregateId } from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateDynamoDBEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

export function createDynamoDBGetEvents<PE, PS>(
  settings: Settings<PE, PS>,
): EventStore<PE, PS>["getEventsByIdSinceSeqNr"] {
  return async (aggregateId, seqNr) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    const start = validateSeqNr(seqNr);
    if (start.type === "err") return start;
    const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;
    const request = {
      TableName: settings.tables.journal,
      KeyConditionExpression: "aid = :aid AND seq_nr >= :seq_nr",
      ExpressionAttributeValues: {
        ":aid": { S: aid },
        ":seq_nr": { N: start.value.toString() },
      },
      ConsistentRead: true,
      ScanIndexForward: true,
    };

    // 蓄積配列は呼出し内だけで更新し、全頁・全復元の成功後に公開する。
    const items: Record<string, AttributeValue>[] = [];
    let cursor: Record<string, AttributeValue> | undefined;
    try {
      do {
        const response = await settings.client.send(
          new QueryCommand({
            ...request,
            ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
          }),
        );
        for (const item of response.Items ?? []) items.push(item);
        cursor = response.LastEvaluatedKey;
      } while (cursor !== undefined && Object.keys(cursor).length !== 0);
    } catch (cause) {
      return Result.err(
        EventStoreError.storage("event journal query failed", cause),
      );
    }

    const events: EventEnvelope<PE>[] = [];
    for (const item of items) {
      const restored = restoreDynamoDBEventEnvelope(
        item,
        validatedId.value,
        settings.eventSerializer,
      );
      if (restored.type === "err") return restored;
      events.push(restored.value);
    }
    return Result.ok(events);
  };
}
