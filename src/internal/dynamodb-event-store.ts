import {
  type AttributeValue,
  type DynamoDBClient,
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
  type EventSerializer,
  type KeyResolver,
  type Logger,
  OptimisticLockError,
  type SnapshotSerializer,
} from "../types";
import { DefaultKeyResolver } from "./default-key-resolver";
import {
  JsonEventSerializer,
  JsonSnapshotSerializer,
} from "./default-serializer";
import { normalizeDynamoDBDeleteTtlMillis } from "./dynamodb-delete-ttl-millis";
import { DynamoDBSnapshotRetentionExecutor } from "./dynamodb-snapshot-retention-executor";
import {
  assertEventMatchesAggregate,
  assertPersistableUpdateEvent,
} from "./event-store-assertions";
import { convertJson } from "./json-converter";

interface DefaultSnapshotAggregate
  extends Aggregate<DefaultSnapshotAggregate, AggregateId> {}

class DynamoDBEventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> implements EventStore<AID, A, E>
{
  private static readonly SHARED_KEY_RESOLVER =
    new DefaultKeyResolver<AggregateId>();
  private static readonly SHARED_EVENT_SERIALIZER = new JsonEventSerializer<
    AggregateId,
    Event<AggregateId>
  >();
  private static readonly SHARED_SNAPSHOT_SERIALIZER =
    new JsonSnapshotSerializer<AggregateId, DefaultSnapshotAggregate>();

  private readonly dynamodbClient: DynamoDBClient;
  private readonly journalTableName: string;
  private readonly snapshotTableName: string;
  private readonly journalAidIndexName: string;
  private readonly snapshotAidIndexName: string;
  private readonly snapshotActiveTtlIndexName: string;
  private readonly shardCount: number;
  private readonly eventConverter: (json: unknown) => E;
  private readonly snapshotConverter: (json: unknown) => A;
  private readonly keepSnapshotCount: number | undefined;
  private readonly deleteTtlMillis: number | undefined;
  private readonly keyResolver: KeyResolver<AID>;
  private readonly eventSerializer: EventSerializer<AID, E>;
  private readonly snapshotSerializer: SnapshotSerializer<AID, A>;
  private readonly logger: Logger | undefined;

  constructor(input: DynamoDBEventStoreInput<AID, A, E>) {
    this.assertConverter("eventConverter", input.eventConverter);
    this.assertConverter("snapshotConverter", input.snapshotConverter);
    this.dynamodbClient = input.client;
    this.journalTableName = input.journalTableName;
    this.snapshotTableName = input.snapshotTableName;
    this.journalAidIndexName = input.journalAidIndexName;
    this.snapshotAidIndexName = input.snapshotAidIndexName;
    this.snapshotActiveTtlIndexName = input.snapshotActiveTtlIndexName;
    this.shardCount = input.shardCount;
    this.eventConverter = input.eventConverter;
    this.snapshotConverter = input.snapshotConverter;
    this.keepSnapshotCount = input.keepSnapshotCount;
    this.deleteTtlMillis = this.normalizeDeleteTtlMillis(input.deleteTtlMillis);
    this.keyResolver = input.keyResolver ?? DynamoDBEventStore.keyResolver();
    this.eventSerializer =
      input.eventSerializer ?? DynamoDBEventStore.eventSerializer();
    this.snapshotSerializer =
      input.snapshotSerializer ?? DynamoDBEventStore.snapshotSerializer();
    this.logger = input.logger;
  }

  async getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
    // converter: (json: string) => E,
  ): Promise<E[]> {
    this.logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}, ...): start`,
    );
    const request: QueryCommandInput = {
      TableName: this.journalTableName,
      IndexName: this.journalAidIndexName,
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
    const queryResult = await this.dynamodbClient.send(
      new QueryCommand(request),
    );
    let result: E[];
    if (queryResult.Items === undefined) {
      result = [];
    } else {
      result = queryResult.Items.map((item) => {
        const payload = item.payload.B;
        if (payload === undefined) {
          throw new Error("Payload is undefined");
        }
        return this.eventSerializer.deserialize(payload, (json) =>
          this.convertEventJson(json),
        );
      });
    }
    this.logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}, ...): finished`,
    );
    return result;
  }

  async getLatestSnapshotById(
    id: AID,
    // converter: (json: string) => A,
  ): Promise<A | undefined> {
    this.logger?.debug(
      `getLatestSnapshotById(${JSON.stringify(id)}, ...): start`,
    );
    const request: QueryCommandInput = {
      TableName: this.snapshotTableName,
      IndexName: this.snapshotAidIndexName,
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
    const queryResult = await this.dynamodbClient.send(
      new QueryCommand(request),
    );
    if (queryResult.Items === undefined || queryResult.Items.length === 0) {
      return undefined;
    }
    const item = queryResult.Items[0];
    const version = item.version.N;
    if (version === undefined) {
      throw new Error("Version is undefined");
    }
    const payload = item.payload.B;
    if (payload === undefined) {
      throw new Error("Payload is undefined");
    }
    const result = this.snapshotSerializer.deserialize(payload, (json) =>
      this.convertSnapshotJson(json),
    );
    this.logger?.debug(
      `getLatestSnapshotById(${JSON.stringify(id)}, ...): finished`,
    );
    return result.withVersion(Number(version));
  }

  async persistEvent(event: E, version: number): Promise<void> {
    this.logger?.debug(
      `persistEvent(${JSON.stringify(event)}, ${version}): start`,
    );
    assertPersistableUpdateEvent(event);
    await this.updateEventAndSnapshotOpt(event, version, undefined);
    await this.purgeExcessSnapshots(event);
    this.logger?.debug(
      `persistEvent(${JSON.stringify(event)}, ${version}): finished`,
    );
  }

  async persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    assertEventMatchesAggregate(event, aggregate);
    this.logger?.debug(
      `persistEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): start`,
    );
    if (event.isCreated) {
      await this.createEventAndSnapshot(event, aggregate);
    } else {
      await this.updateEventAndSnapshotOpt(event, aggregate.version, aggregate);
    }
    await this.purgeExcessSnapshots(event);
    this.logger?.debug(
      `persistEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): finished`,
    );
  }

  private async createEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    this.logger?.debug(
      `private createEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): start`,
    );
    const putSnapshot = this.putSnapshot(event, 0, aggregate, 1);
    const putRedundantSnapshot = this.putRedundantSnapshot(event, aggregate, 1);
    const putJournal = this.putJournal(event);
    const transactWriteItems = [
      {
        Put: putSnapshot,
      },
      {
        Put: putJournal,
      },
    ];
    if (putRedundantSnapshot !== undefined) {
      transactWriteItems.push({
        Put: putRedundantSnapshot,
      });
    }
    const input: TransactWriteItemsInput = {
      TransactItems: transactWriteItems,
    };
    try {
      await this.dynamodbClient.send(new TransactWriteItemsCommand(input));
    } catch (e) {
      if (
        e instanceof TransactionCanceledException &&
        e.CancellationReasons?.some((e) => e.Code === "ConditionalCheckFailed")
      ) {
        throw new OptimisticLockError("Optimistic locking failed", e);
      }
      throw e;
    }
    this.logger?.debug("private createEventAndSnapshot(...): finished");
  }

  private async updateEventAndSnapshotOpt(
    event: E,
    version: number,
    aggregate: A | undefined,
  ): Promise<void> {
    this.logger?.debug(
      `private updateEventAndSnapshotOpt(${JSON.stringify(
        event,
      )}, ${version}, ${JSON.stringify(aggregate)}): start`,
    );
    const update = this.updateSnapshot(event, 0, version, aggregate);
    const putRedundantSnapshot =
      aggregate === undefined
        ? undefined
        : this.putRedundantSnapshot(event, aggregate, version + 1);
    const put = this.putJournal(event);
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
    const input: TransactWriteItemsInput = {
      TransactItems: transactWriteItems,
    };
    try {
      await this.dynamodbClient.send(new TransactWriteItemsCommand(input));
    } catch (e) {
      if (
        e instanceof TransactionCanceledException &&
        e.CancellationReasons?.some((e) => e.Code === "ConditionalCheckFailed")
      ) {
        throw new OptimisticLockError("Optimistic locking failed", e);
      }
      throw e;
    }
    this.logger?.debug("private updateEventAndSnapshotOpt(...): finished");
  }

  private putJournal(event: E): Put {
    this.logger?.debug(`private putSnapshot(${JSON.stringify(event)}): start`);
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId,
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId,
      event.sequenceNumber,
    );
    const payload = this.eventSerializer.serialize(event);
    const result = {
      TableName: this.journalTableName,
      Item: {
        pkey: { S: pkey },
        skey: { S: skey },
        aid: { S: event.aggregateId.asString() },
        seq_nr: { N: event.sequenceNumber.toString() },
        payload: { B: payload },
        occurred_at: { N: event.occurredAt.getUTCMilliseconds().toString() },
      },
      ConditionExpression:
        "attribute_not_exists(pkey) AND attribute_not_exists(skey)",
    };
    this.logger?.debug("private putSnapshot(...): finished");
    return result;
  }

  private putSnapshot(
    event: E,
    sequenceNumber: number,
    aggregate: A,
    version: number,
  ): Put {
    this.logger?.debug(
      `private putSnapshot(${JSON.stringify(
        event,
      )}, ${sequenceNumber}, ${JSON.stringify(aggregate)}): start`,
    );
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId,
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId,
      sequenceNumber,
    );
    const payload = this.snapshotSerializer.serialize(aggregate);
    const item: Record<string, AttributeValue> = {
      pkey: { S: pkey },
      skey: { S: skey },
      payload: { B: payload },
      aid: { S: event.aggregateId.asString() },
      seq_nr: { N: sequenceNumber.toString() },
      version: { N: version.toString() },
      ttl: { N: "0" },
      last_updated_at: {
        N: event.occurredAt.getUTCMilliseconds().toString(),
      },
    };
    if (sequenceNumber > 0) {
      item.active_ttl_seq_nr = { N: sequenceNumber.toString() };
    }
    const result = {
      TableName: this.snapshotTableName,
      Item: item,
      ConditionExpression:
        "attribute_not_exists(pkey) AND attribute_not_exists(skey)",
    };
    this.logger?.debug(`result = ${JSON.stringify(result)}`);
    this.logger?.debug("private putSnapshot(...): finished");
    return result;
  }

  private putRedundantSnapshot(
    event: E,
    aggregate: A,
    version: number,
  ): Put | undefined {
    if (this.keepSnapshotCount === undefined) {
      return undefined;
    }
    // Redundant snapshots are immutable; version records the primary snapshot
    // version at the time this copy was written.
    return this.putSnapshot(event, event.sequenceNumber, aggregate, version);
  }

  private updateSnapshot(
    event: E,
    sequenceNumber: number,
    version: number,
    aggregate: A | undefined,
  ): Update {
    this.logger?.debug(
      `private updateSnapshot(event = ${JSON.stringify(
        event,
      )}, sequenceNumber = ${sequenceNumber}, version = ${version}, aggregate = ${JSON.stringify(aggregate)}): start`,
    );
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId,
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId,
      sequenceNumber,
    );
    const keys = {
      pkey: { S: pkey },
      skey: { S: skey },
    };
    const names = {
      "#version": "version",
      "#last_updated_at": "last_updated_at",
    };
    const values = {
      ":before_version": { N: version.toString() },
      ":after_version": { N: (version + 1).toString() },
      ":last_updated_at": {
        N: event.occurredAt.getUTCMilliseconds().toString(),
      },
    };
    let result: Update;
    if (aggregate === undefined) {
      result = {
        TableName: this.snapshotTableName,
        UpdateExpression:
          "SET #version=:after_version, #last_updated_at=:last_updated_at",
        Key: { ...keys },
        ExpressionAttributeNames: { ...names },
        ExpressionAttributeValues: { ...values },
        ConditionExpression: "#version=:before_version",
      };
    } else {
      const payload = this.snapshotSerializer.serialize(aggregate);
      result = {
        TableName: this.snapshotTableName,
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
    this.logger?.debug(`result·=·${JSON.stringify(result)}`);
    this.logger?.debug("private·updateSnapshot(...):·finished");
    return result;
  }

  private async purgeExcessSnapshots(event: E) {
    const executor = new DynamoDBSnapshotRetentionExecutor<AID>(
      this.dynamodbClient,
      this.snapshotTableName,
      this.snapshotAidIndexName,
      this.snapshotActiveTtlIndexName,
    );
    await executor.purgeExcessSnapshots(
      event.aggregateId,
      this.keepSnapshotCount,
      this.deleteTtlMillis,
    );
  }

  private assertConverter(name: string, converter: unknown): void {
    if (typeof converter !== "function") {
      throw new Error(`${name} must be a function`);
    }
    // Runtime signature probing would execute user conversion logic with fake data.
    // The contract is type-level: converters accept decoded JSON as unknown and return the target type.
    // Converter invocation errors are wrapped at serializer call sites.
  }

  private convertEventJson(json: unknown): E {
    return convertJson("eventConverter", this.eventConverter, json);
  }

  private convertSnapshotJson(json: unknown): A {
    return convertJson("snapshotConverter", this.snapshotConverter, json);
  }

  private normalizeDeleteTtlMillis(
    deleteTtlMillis: number | undefined,
  ): number | undefined {
    try {
      return normalizeDynamoDBDeleteTtlMillis(deleteTtlMillis);
    } catch (error) {
      throw new Error(
        `Invalid deleteTtlMillis configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private static keyResolver<AID extends AggregateId>(): KeyResolver<AID> {
    return DynamoDBEventStore.SHARED_KEY_RESOLVER as KeyResolver<AID>;
  }

  private static eventSerializer<
    AID extends AggregateId,
    E extends Event<AID>,
  >(): EventSerializer<AID, E> {
    return DynamoDBEventStore.SHARED_EVENT_SERIALIZER as unknown as EventSerializer<
      AID,
      E
    >;
  }

  private static snapshotSerializer<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
  >(): SnapshotSerializer<AID, A> {
    return DynamoDBEventStore.SHARED_SNAPSHOT_SERIALIZER as unknown as SnapshotSerializer<
      AID,
      A
    >;
  }
}

export { DynamoDBEventStore };
