import {
  type AttributeValue,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { Result } from "../../result";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import type { SnapshotEnvelope } from "../snapshot-envelope";
import type { validateDynamoDBEventStoreInput } from "./dynamodb-event-store-input-validation";
import { dynamoDBItemSize } from "./dynamodb-item-size";
import { classifyDynamoDBPersistEventError } from "./dynamodb-persist-event-error";
import { notifyDynamoDBRetentionFailure } from "./dynamodb-retention-failure-notification";
import type { DynamoDBRetentionHooks } from "./dynamodb-retention-hooks";
import { retainDynamoDBSnapshots } from "./dynamodb-snapshot-retention";
import {
  validateEvent,
  validateEventAndSnapshot,
} from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateDynamoDBEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

export function createDynamoDBPersistEvent<PE, PS>(
  settings: Settings<PE, PS>,
  hooks?: DynamoDBRetentionHooks,
): EventStore<PE, PS>["persistEvent"] {
  return async (event) => {
    const validated = validateEvent(event);
    if (validated.type === "err") return validated;
    return persistDynamoDBEvent(settings, validated.value, undefined, hooks);
  };
}

export function createDynamoDBPersistEventAndSnapshot<PE, PS>(
  settings: Settings<PE, PS>,
  hooks?: DynamoDBRetentionHooks,
): EventStore<PE, PS>["persistEventAndSnapshot"] {
  return async (event, snapshot) => {
    const validated = validateEventAndSnapshot(event, snapshot);
    if (validated.type === "err") return validated;
    return persistDynamoDBEvent(
      settings,
      validated.value.event,
      validated.value.snapshot,
      hooks,
    );
  };
}

async function persistDynamoDBEvent<PE, PS>(
  settings: Settings<PE, PS>,
  event: EventEnvelope<PE>,
  snapshot?: SnapshotEnvelope<PS>,
  hooks?: DynamoDBRetentionHooks,
): Promise<Result<void, EventStoreError>> {
  const { client, tables, eventSerializer, snapshotSerializer, retention } =
    settings;
  const { aggregateId, seqNr, manifest, occurredAt, payload } = event;
  const aid = `${aggregateId.typeName}-${aggregateId.value}`;
  const typeName = aggregateId.typeName;
  const millis = occurredAt.getTime();
  const nanos = (BigInt(millis) * BigInt(1000000)).toString();
  const snapshotInput =
    snapshot === undefined
      ? undefined
      : {
          aggregate: snapshot.aggregate,
          metadata: {
            aid: { S: aid },
            skey: { N: "0" },
            seq_nr: { N: snapshot.seqNr.toString() },
            last_updated_at: { N: millis.toString() },
            manifest: { S: snapshot.manifest },
          },
        };

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

  let snapshotItems: Record<string, AttributeValue>[] = [];
  if (snapshotInput !== undefined) {
    let snapshotBytes: Uint8Array;
    try {
      const serialized = snapshotSerializer.serialize(snapshotInput.aggregate);
      if (!(serialized instanceof Uint8Array))
        throw new TypeError("serializer.serialize must return Uint8Array");
      snapshotBytes = new Uint8Array(serialized);
    } catch (cause) {
      return Result.err(
        EventStoreError.serialization(
          "serialize",
          "snapshot payload serialization failed",
          cause,
        ),
      );
    }
    const current: Record<string, AttributeValue> = {
      ...snapshotInput.metadata,
      payload: { B: snapshotBytes },
    };
    snapshotItems =
      retention === undefined
        ? [current]
        : [
            current,
            {
              ...current,
              skey: snapshotInput.metadata.seq_nr,
              active_history_seq_nr: snapshotInput.metadata.seq_nr,
            },
          ];
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
  if (
    [journal, head, ...snapshotItems].some(
      (item) => dynamoDBItemSize(item) > 409600,
    )
  )
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
          ...snapshotItems.map((item) => ({
            Put: { TableName: tables.snapshot, Item: item },
          })),
        ],
      }),
    );
  } catch (cause) {
    return Result.err(classifyDynamoDBPersistEventError(cause, aid, seqNr));
  }
  if (snapshotInput !== undefined && retention !== undefined) {
    try {
      await retainDynamoDBSnapshots(
        { ...settings, retention },
        aid,
        Number(snapshotInput.metadata.seq_nr.N),
        hooks,
      );
    } catch (cause) {
      await notifyDynamoDBRetentionFailure(
        aid,
        cause,
        settings.logger,
        settings.onRetentionFailure,
      );
    }
  }
  return Result.ok(undefined);
}
