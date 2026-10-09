import {
  type AttributeValue,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { Result } from "../../result";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import type { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { dynamoDBItemSize } from "./dynamodb-item-size";
import { classifyDynamoDBPersistEventError } from "./dynamodb-persist-event-error";
import { validateEvent } from "./validated-event-store";

export function createDynamoDBPersistEvent<PE, PS>(
  settings: Extract<
    ReturnType<typeof validateDynamoDBEventStoreInput<PE, PS>>,
    { type: "ok" }
  >["value"],
): EventStore<PE, PS>["persistEvent"] {
  const { client, tables, eventSerializer } = settings;
  return async (event) => {
    const validated = validateEvent(event);
    if (validated.type === "err") return validated;
    const { aggregateId, seqNr, manifest, occurredAt, payload } =
      validated.value;
    const aid = `${aggregateId.typeName}-${aggregateId.value}`;
    const typeName = aggregateId.typeName;
    const nanos = (BigInt(occurredAt.getTime()) * BigInt(1000000)).toString();

    let bytes: Uint8Array;
    try {
      const serialized = eventSerializer.serialize(payload);
      if (!(serialized instanceof Uint8Array))
        throw new TypeError("serializer.serialize must return Uint8Array");
      bytes = new Uint8Array(serialized);
    } catch (cause) {
      return Result.err(
        EventStoreError.serialization(
          "serialize",
          "event payload serialization failed",
          cause,
        ),
      );
    }

    const fields: Record<string, AttributeValue> = {
      seq_nr: { N: seqNr.toString() },
      occurred_at: { N: nanos },
      manifest: { S: manifest },
      payload: { B: bytes },
    };
    const journal: Record<string, AttributeValue> = {
      aid: { S: aid },
      ...fields,
    };
    const head: Record<string, AttributeValue> = {
      aid: { S: aid },
      type_name: { S: typeName },
      seq_nr: fields.seq_nr,
      events: { L: [{ M: fields }] },
    };
    if ([journal, head].some((item) => dynamoDBItemSize(item) > 409600))
      return Result.err(
        EventStoreError.contractViolation({ rule: "D-7", seqNr }),
      );

    try {
      await client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tables.journal,
                Item: journal,
                ConditionExpression: "attribute_not_exists(aid)",
              },
            },
            seqNr === 1
              ? {
                  Put: {
                    TableName: tables.head,
                    Item: head,
                    ConditionExpression: "attribute_not_exists(aid)",
                    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                  },
                }
              : {
                  Update: {
                    TableName: tables.head,
                    Key: { aid: { S: aid } },
                    ConditionExpression: "seq_nr = :prev",
                    UpdateExpression: "SET seq_nr = :seq, #events = :events",
                    ExpressionAttributeNames: { "#events": "events" },
                    ExpressionAttributeValues: {
                      ":prev": { N: (seqNr - 1).toString() },
                      ":seq": head.seq_nr,
                      ":events": head.events,
                    },
                    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                  },
                },
          ],
        }),
      );
      return Result.ok(undefined);
    } catch (cause) {
      return Result.err(classifyDynamoDBPersistEventError(cause, aid, seqNr));
    }
  };
}
