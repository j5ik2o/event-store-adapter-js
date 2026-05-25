import {
  type AttributeValue,
  type Put,
  QueryCommand,
  type QueryCommandInput,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItemsInput,
  type Update,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import type { EventStore } from "../event-store";
import {
  type Aggregate,
  type AggregateId,
  type Event,
  EventStoreError,
  Result,
  ShardCount,
} from "../types";
import {
  createJsonEventSerializer,
  createJsonSnapshotSerializer,
} from "./default-serializer";
import { createDefaultShardSelector } from "./default-shard-selector";
import { createDynamoDBAggregateKey } from "./dynamodb-aggregate-key";
import { normalizeDynamoDBDeleteTtlMillis } from "./dynamodb-delete-ttl-millis";
import { createDynamoDBSnapshotRetentionExecutor } from "./dynamodb-snapshot-retention-executor";
import {
  assertEventMatchesAggregate,
  assertPersistableUpdateEvent,
} from "./event-store-assertions";
import { convertJson } from "./json-converter";

function createDynamoDBEventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
>(input: DynamoDBEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
  assertConverter("eventConverter", input.eventConverter);
  assertConverter("snapshotConverter", input.snapshotConverter);

  const dynamodbClient = input.client;
  const journalTableName = input.journalTableName;
  const snapshotTableName = input.snapshotTableName;
  const journalAidIndexName = input.journalAidIndexName;
  const snapshotAidIndexName = input.snapshotAidIndexName;
  const snapshotActiveTtlIndexName = input.snapshotActiveTtlIndexName;
  const shardCount = parseShardCount(input.shardCount);
  const eventConverter = input.eventConverter;
  const snapshotConverter = input.snapshotConverter;
  const keepSnapshotCount =
    input.keepSnapshotCount === undefined
      ? undefined
      : normalizeKeepSnapshotCount(input.keepSnapshotCount);
  const deleteTtlMillis = normalizeDeleteTtlMillis(input.deleteTtlMillis);
  const shardSelector =
    input.shardSelector ?? createDefaultShardSelector<AID>();
  const eventSerializer = input.eventSerializer ?? createJsonEventSerializer();
  const snapshotSerializer =
    input.snapshotSerializer ?? createJsonSnapshotSerializer();
  const logger = input.logger;

  async function getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]> {
    logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}, ...): start`,
    );
    const request: QueryCommandInput = {
      TableName: journalTableName,
      IndexName: journalAidIndexName,
      KeyConditionExpression: "#aid = :aid AND #seq_nr >= :seq_nr",
      ExpressionAttributeNames: {
        "#aid": "aid",
        "#seq_nr": "seq_nr",
      },
      ExpressionAttributeValues: {
        ":aid": { S: id.asString() },
        ":seq_nr": { N: sequenceNumber.toString() },
      },
    };
    const queryResult = await dynamodbClient.send(new QueryCommand(request));
    const result =
      queryResult.Items === undefined
        ? []
        : queryResult.Items.map((item) => {
            const payload = item.payload?.B;
            if (payload === undefined) {
              throw new Error("Payload is undefined");
            }
            return eventSerializer.deserialize(payload, (json) =>
              convertJson("eventConverter", eventConverter, json),
            );
          });
    logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}, ...): finished`,
    );
    return result;
  }

  async function getLatestSnapshotById(id: AID): Promise<A | undefined> {
    logger?.debug(`getLatestSnapshotById(${JSON.stringify(id)}, ...): start`);
    const request: QueryCommandInput = {
      TableName: snapshotTableName,
      IndexName: snapshotAidIndexName,
      KeyConditionExpression: "#aid = :aid AND #seq_nr = :seq_nr",
      ExpressionAttributeNames: {
        "#aid": "aid",
        "#seq_nr": "seq_nr",
      },
      ExpressionAttributeValues: {
        ":aid": { S: id.asString() },
        ":seq_nr": { N: "0" },
      },
      Limit: 1,
    };
    const queryResult = await dynamodbClient.send(new QueryCommand(request));
    if (queryResult.Items === undefined || queryResult.Items.length === 0) {
      return undefined;
    }
    const item = queryResult.Items[0];
    const version = item.version?.N;
    if (version === undefined) {
      throw new Error("Version is undefined");
    }
    const payload = item.payload?.B;
    if (payload === undefined) {
      throw new Error("Payload is undefined");
    }
    const result = snapshotSerializer.deserialize(payload, (json) =>
      convertJson("snapshotConverter", snapshotConverter, json),
    );
    logger?.debug(
      `getLatestSnapshotById(${JSON.stringify(id)}, ...): finished`,
    );
    return result.withVersion(Number(version));
  }

  async function persistEvent(event: E, expectedVersion: number) {
    logger?.debug(
      `persistEvent(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, expectedVersion=${expectedVersion}): start`,
    );
    assertPersistableUpdateEvent(event);
    const writeError = await updateEventAndSnapshotOpt(
      event,
      expectedVersion,
      undefined,
    );
    if (writeError !== undefined) {
      return Result.err(writeError);
    }
    const purgeError = await purgeExcessSnapshots(event);
    if (purgeError !== undefined) {
      return Result.err(purgeError);
    }
    logger?.debug(
      `persistEvent(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, expectedVersion=${expectedVersion}): finished`,
    );
    return Result.ok(undefined);
  }

  async function persistEventAndSnapshot(event: E, aggregate: A) {
    assertEventMatchesAggregate(event, aggregate);
    logger?.debug(
      `persistEventAndSnapshot(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, aggregateVersion=${aggregate.version}): start`,
    );
    const writeError = event.isCreated
      ? await createEventAndSnapshot(event, aggregate)
      : await updateEventAndSnapshotOpt(event, aggregate.version, aggregate);
    if (writeError !== undefined) {
      return Result.err(writeError);
    }
    const purgeError = await purgeExcessSnapshots(event);
    if (purgeError !== undefined) {
      return Result.err(purgeError);
    }
    logger?.debug(
      `persistEventAndSnapshot(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, aggregateVersion=${aggregate.version}): finished`,
    );
    return Result.ok(undefined);
  }

  async function createEventAndSnapshot(
    event: E,
    aggregate: A,
  ): Promise<EventStoreError | undefined> {
    let request: TransactWriteItemsInput;
    try {
      const putSnapshotRequest = putSnapshot(event, 0, aggregate, 1);
      const putRedundantSnapshot = createPutRedundantSnapshot(
        event,
        aggregate,
        1,
      );
      const putJournalRequest = putJournal(event);
      const transactWriteItems = [
        {
          Put: putSnapshotRequest,
        },
        {
          Put: putJournalRequest,
        },
      ];
      if (putRedundantSnapshot !== undefined) {
        transactWriteItems.push({
          Put: putRedundantSnapshot,
        });
      }
      request = {
        TransactItems: transactWriteItems,
      };
    } catch (error) {
      if (isEventStoreError(error)) {
        return error;
      }
      throw error;
    }
    return sendTransactWriteItems(request);
  }

  async function updateEventAndSnapshotOpt(
    event: E,
    expectedVersion: number,
    aggregate: A | undefined,
  ): Promise<EventStoreError | undefined> {
    let request: TransactWriteItemsInput;
    try {
      const update = updateSnapshot(event, 0, expectedVersion, aggregate);
      const putRedundantSnapshot =
        aggregate === undefined
          ? undefined
          : createPutRedundantSnapshot(event, aggregate, expectedVersion + 1);
      const put = putJournal(event);
      const transactWriteItems = [
        {
          Update: update,
        },
        {
          Put: put,
        },
      ];
      if (putRedundantSnapshot !== undefined) {
        transactWriteItems.push({
          Put: putRedundantSnapshot,
        });
      }
      request = {
        TransactItems: transactWriteItems,
      };
    } catch (error) {
      if (isEventStoreError(error)) {
        return error;
      }
      throw error;
    }
    return sendTransactWriteItems(request);
  }

  async function sendTransactWriteItems(
    request: TransactWriteItemsInput,
  ): Promise<EventStoreError | undefined> {
    try {
      await dynamodbClient.send(new TransactWriteItemsCommand(request));
      return undefined;
    } catch (error) {
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.some(
          (reason) => reason.Code === "ConditionalCheckFailed",
        )
      ) {
        return EventStoreError.optimisticLockConflict(
          "Optimistic locking failed",
          error,
        );
      }
      return EventStoreError.storage("DynamoDB write failed", error);
    }
  }

  function putJournal(event: E): Put {
    const key = createDynamoDBAggregateKey(
      event.aggregateId,
      event.sequenceNumber,
      shardSelector,
      shardCount,
    );
    const payload = serializeEvent(event);
    return {
      TableName: journalTableName,
      Item: {
        pkey: { S: key.partitionKeyValue },
        skey: { S: key.sortKeyValue },
        aid: { S: event.aggregateId.asString() },
        seq_nr: { N: event.sequenceNumber.toString() },
        payload: { B: payload },
        occurred_at: { N: event.occurredAt.getTime().toString() },
      },
      ConditionExpression:
        "attribute_not_exists(pkey) AND attribute_not_exists(skey)",
    };
  }

  function putSnapshot(
    event: E,
    sequenceNumber: number,
    aggregate: A,
    version: number,
  ): Put {
    const key = createDynamoDBAggregateKey(
      event.aggregateId,
      sequenceNumber,
      shardSelector,
      shardCount,
    );
    const payload = serializeSnapshot(aggregate);
    const item: Record<string, AttributeValue> = {
      pkey: { S: key.partitionKeyValue },
      skey: { S: key.sortKeyValue },
      payload: { B: payload },
      aid: { S: event.aggregateId.asString() },
      seq_nr: { N: sequenceNumber.toString() },
      version: { N: version.toString() },
      ttl: { N: "0" },
      last_updated_at: {
        N: event.occurredAt.getTime().toString(),
      },
    };
    if (sequenceNumber > 0) {
      item.active_ttl_seq_nr = { N: sequenceNumber.toString() };
    }
    return {
      TableName: snapshotTableName,
      Item: item,
      ConditionExpression:
        "attribute_not_exists(pkey) AND attribute_not_exists(skey)",
    };
  }

  function createPutRedundantSnapshot(
    event: E,
    aggregate: A,
    version: number,
  ): Put | undefined {
    if (keepSnapshotCount === undefined || keepSnapshotCount === 0) {
      return undefined;
    }
    return putSnapshot(event, event.sequenceNumber, aggregate, version);
  }

  function updateSnapshot(
    event: E,
    sequenceNumber: number,
    version: number,
    aggregate: A | undefined,
  ): Update {
    const key = createDynamoDBAggregateKey(
      event.aggregateId,
      sequenceNumber,
      shardSelector,
      shardCount,
    );
    const keys = {
      pkey: { S: key.partitionKeyValue },
      skey: { S: key.sortKeyValue },
    };
    const names = {
      "#version": "version",
      "#last_updated_at": "last_updated_at",
    };
    const values = {
      ":before_version": { N: version.toString() },
      ":after_version": { N: (version + 1).toString() },
      ":last_updated_at": {
        N: event.occurredAt.getTime().toString(),
      },
    };
    if (aggregate === undefined) {
      return {
        TableName: snapshotTableName,
        UpdateExpression:
          "SET #version=:after_version, #last_updated_at=:last_updated_at",
        Key: { ...keys },
        ExpressionAttributeNames: { ...names },
        ExpressionAttributeValues: { ...values },
        ConditionExpression: "#version=:before_version",
      };
    }
    const payload = serializeSnapshot(aggregate);
    return {
      TableName: snapshotTableName,
      UpdateExpression:
        "SET #payload=:payload, #seq_nr=:seq_nr, #version=:after_version, #last_updated_at=:last_updated_at",
      Key: { ...keys },
      ExpressionAttributeNames: {
        ...names,
        "#seq_nr": "seq_nr",
        "#payload": "payload",
      },
      ExpressionAttributeValues: {
        ...values,
        ":seq_nr": { N: sequenceNumber.toString() },
        ":payload": { B: payload },
      },
      ConditionExpression: "#version=:before_version",
    };
  }

  async function purgeExcessSnapshots(
    event: E,
  ): Promise<EventStoreError | undefined> {
    try {
      const executor = createDynamoDBSnapshotRetentionExecutor<AID>(
        dynamodbClient,
        snapshotTableName,
        snapshotAidIndexName,
        snapshotActiveTtlIndexName,
      );
      await executor.purgeExcessSnapshots(
        event.aggregateId,
        keepSnapshotCount,
        deleteTtlMillis,
      );
      return undefined;
    } catch (error) {
      return EventStoreError.storage(
        "DynamoDB snapshot retention failed",
        error,
      );
    }
  }

  function assertConverter(name: string, converter: unknown): void {
    if (typeof converter !== "function") {
      throw createConfigurationError(name, new Error("must be a function"));
    }
  }

  function parseShardCount(shardCountInput: number): ShardCount {
    try {
      return ShardCount.create(shardCountInput);
    } catch (cause) {
      throw createConfigurationError("shardCount", cause);
    }
  }

  function normalizeDeleteTtlMillis(
    deleteTtlMillisInput: number | undefined,
  ): number | undefined {
    try {
      return normalizeDynamoDBDeleteTtlMillis(deleteTtlMillisInput);
    } catch (error) {
      throw createConfigurationError("deleteTtlMillis", error);
    }
  }

  function normalizeKeepSnapshotCount(keepSnapshotCountInput: number): number {
    if (!Number.isFinite(keepSnapshotCountInput)) {
      throw createConfigurationError(
        "keepSnapshotCount",
        new Error(`must be finite, got ${keepSnapshotCountInput}`),
      );
    }
    return Math.max(0, Math.floor(keepSnapshotCountInput));
  }

  function isEventStoreError(error: unknown): error is EventStoreError {
    return (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      typeof (error as { type: unknown }).type === "string" &&
      [
        "optimistic-lock-conflict",
        "configuration-error",
        "serialization-error",
        "storage-error",
      ].includes((error as { type: string }).type)
    );
  }

  function serializeEvent(event: E): Uint8Array {
    try {
      return eventSerializer.serialize(event);
    } catch (error) {
      throw EventStoreError.serialization(
        "serialize",
        "DynamoDB event serialization failed",
        error,
      );
    }
  }

  function serializeSnapshot(aggregate: A): Uint8Array {
    try {
      return snapshotSerializer.serialize(aggregate);
    } catch (error) {
      throw EventStoreError.serialization(
        "serialize",
        "DynamoDB snapshot serialization failed",
        error,
      );
    }
  }

  return Object.freeze({
    persistEvent,
    persistEventAndSnapshot,
    getEventsByIdSinceSequenceNumber,
    getLatestSnapshotById,
  });
}

function createConfigurationError(fieldName: string, cause: unknown): Error {
  /* istanbul ignore next -- internal callers pass Error causes. */
  const message = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`Invalid ${fieldName} configuration: ${message}`);
  error.name = "DynamoDBEventStoreConfigurationError";
  error.cause = cause;
  return error;
}

export { createDynamoDBEventStore };
