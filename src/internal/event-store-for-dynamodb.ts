import {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  Logger,
  OptimisticLockError,
  SnapshotSerializer,
} from "../types";
import {
  BatchWriteItemCommand,
  DynamoDBClient,
  Put,
  QueryCommand,
  QueryCommandInput,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  TransactWriteItemsInput,
  Update,
  UpdateItemCommand,
  UpdateItemInput,
  WriteRequest,
} from "@aws-sdk/client-dynamodb";
import moment from "moment/moment";
import { DefaultKeyResolver } from "./default-key-resolver";
import {
  JsonEventSerializer,
  JsonSnapshotSerializer,
} from "./default-serializer";
import { EventStoreWithOptions } from "../event-store-with-options";

class EventStoreForDynamoDB<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> implements EventStoreWithOptions<AID, A, E>
{
  constructor(
    private dynamodbClient: DynamoDBClient,
    private journalTableName: string,
    private snapshotTableName: string,
    private journalAidIndexName: string,
    private snapshotAidIndexName: string,
    private shardCount: number,
    private eventConverter: (json: string) => E,
    private snapshotConverter: (json: string) => A,
    private keepSnapshotCount: number | undefined = undefined,
    private deleteTtl: moment.Duration | undefined = undefined,
    private keyResolver: KeyResolver<AID> = new DefaultKeyResolver(),
    private eventSerializer: EventSerializer<AID, E> = new JsonEventSerializer<
      AID,
      E
    >(),
    private snapshotSerializer: SnapshotSerializer<
      AID,
      A
    > = new JsonSnapshotSerializer<AID, A>(),
    private logger: Logger | undefined = undefined,
  ) {}

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
        return this.eventSerializer.deserialize(payload, this.eventConverter);
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
    } else {
      const item = queryResult.Items[0];
      const version = item.version.N;
      if (version === undefined) {
        throw new Error("Version is undefined");
      }
      const payload = item.payload.B;
      if (payload === undefined) {
        throw new Error("Payload is undefined");
      }
      const result = this.snapshotSerializer.deserialize(
        payload,
        this.snapshotConverter,
      );
      this.logger?.debug(
        `getLatestSnapshotById(${JSON.stringify(id)}, ...): finished`,
      );
      return result.withVersion(Number(version));
    }
  }

  async persistEvent(event: E, version: number): Promise<void> {
    this.logger?.debug(
      `persistEvent(${JSON.stringify(event)}, ${version}): start`,
    );
    if (event.isCreated) {
      throw new Error("Cannot persist created event");
    }
    await this.updateEventAndSnapshotOpt(event, version, undefined);
    await this.tryPurgeExcessSnapshots(event);
    this.logger?.debug(
      `persistEvent(${JSON.stringify(event)}, ${version}): finished`,
    );
  }

  async persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    if (event.aggregateId.asString() !== aggregate.id.asString()) {
      throw new Error(
        `aggregateId mismatch: expected ${event.aggregateId.asString()}, got ${aggregate.id.asString()}`,
      );
    }
    this.logger?.debug(
      `persistEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): start`,
    );
    if (event.isCreated) {
      await this.createEventAndSnapshot(event, aggregate);
    } else {
      await this.updateEventAndSnapshotOpt(
        event,
        aggregate.sequenceNumber,
        aggregate,
      );
      await this.tryPurgeExcessSnapshots(event);
    }
    this.logger?.debug(
      `persistEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): finished`,
    );
  }

  withDeleteTtl(deleteTtl: moment.Duration): EventStoreWithOptions<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.eventConverter,
      this.snapshotConverter,
      this.keepSnapshotCount,
      deleteTtl,
      this.keyResolver,
      this.eventSerializer,
      this.snapshotSerializer,
      this.logger,
    );
  }

  withEventSerializer(
    eventSerializer: EventSerializer<AID, E>,
  ): EventStoreWithOptions<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.eventConverter,
      this.snapshotConverter,
      this.keepSnapshotCount,
      this.deleteTtl,
      this.keyResolver,
      eventSerializer,
      this.snapshotSerializer,
      this.logger,
    );
  }

  withKeepSnapshotCount(
    keepSnapshotCount: number,
  ): EventStoreWithOptions<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.eventConverter,
      this.snapshotConverter,
      keepSnapshotCount,
      this.deleteTtl,
      this.keyResolver,
      this.eventSerializer,
      this.snapshotSerializer,
      this.logger,
    );
  }

  withKeyResolver(
    keyResolver: KeyResolver<AID>,
  ): EventStoreWithOptions<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.eventConverter,
      this.snapshotConverter,
      this.keepSnapshotCount,
      this.deleteTtl,
      keyResolver,
      this.eventSerializer,
      this.snapshotSerializer,
      this.logger,
    );
  }

  withSnapshotSerializer(
    snapshotSerializer: SnapshotSerializer<AID, A>,
  ): EventStoreWithOptions<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.eventConverter,
      this.snapshotConverter,
      this.keepSnapshotCount,
      this.deleteTtl,
      this.keyResolver,
      this.eventSerializer,
      snapshotSerializer,
      this.logger,
    );
  }

  withLogger(logger: Logger): EventStoreWithOptions<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.eventConverter,
      this.snapshotConverter,
      this.keepSnapshotCount,
      this.deleteTtl,
      this.keyResolver,
      this.eventSerializer,
      this.snapshotSerializer,
      logger,
    );
  }

  private async createEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    this.logger?.debug(
      `private createEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): start`,
    );
    const putSnapshot = this.putSnapshot(event, 0, aggregate);
    const putJournal = this.putJournal(event);
    const transactWriteItems = [
      {
        Put: putSnapshot,
      },
      {
        Put: putJournal,
      },
    ];
    const input: TransactWriteItemsInput = {
      TransactItems: transactWriteItems,
    };
    try {
      await this.dynamodbClient.send(new TransactWriteItemsCommand(input));
    } catch (e) {
      if (
        e instanceof TransactionCanceledException &&
        e.CancellationReasons?.some((e) => e.Code == "ConditionalCheckFailed")
      ) {
        throw new OptimisticLockError("Optimistic locking failed", e);
      } else {
        throw e;
      }
    }
    this.logger?.debug(`private createEventAndSnapshot(...): finished`);
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
    const put = this.putJournal(event);
    const transactWriteItems = [
      {
        Update: update,
      },
      {
        Put: put,
      },
    ];
    const input: TransactWriteItemsInput = {
      TransactItems: transactWriteItems,
    };
    try {
      await this.dynamodbClient.send(new TransactWriteItemsCommand(input));
    } catch (e) {
      if (
        e instanceof TransactionCanceledException &&
        e.CancellationReasons?.some((e) => e.Code == "ConditionalCheckFailed")
      ) {
        throw new OptimisticLockError("Optimistic locking failed", e);
      } else {
        throw e;
      }
    }
    this.logger?.debug(`private updateEventAndSnapshotOpt(...): finished`);
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
    this.logger?.debug(`private putSnapshot(...): finished`);
    return result;
  }

  private putSnapshot(event: E, sequenceNumber: number, aggregate: A): Put {
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
    const result = {
      TableName: this.snapshotTableName,
      Item: {
        pkey: { S: pkey },
        skey: { S: skey },
        payload: { B: payload },
        aid: { S: event.aggregateId.asString() },
        seq_nr: { N: sequenceNumber.toString() },
        version: { N: "1" },
        ttl: { N: "0" },
        last_updated_at: {
          N: event.occurredAt.getUTCMilliseconds().toString(),
        },
      },
      ConditionExpression:
        "attribute_not_exists(pkey) AND attribute_not_exists(skey)",
    };
    this.logger?.debug("result = " + JSON.stringify(result));
    this.logger?.debug(`private putSnapshot(...): finished`);
    return result;
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
    this.logger?.debug("result = " + JSON.stringify(result));
    this.logger?.debug(`private updateSnapshot(...): finished`);
    return result;
  }

  private async tryPurgeExcessSnapshots(event: E) {
    if (this.keepSnapshotCount !== undefined) {
      if (this.deleteTtl !== undefined) {
        await this.updateTtlOfExcessSnapshots(event.aggregateId);
      } else {
        await this.deleteExcessSnapshots(event.aggregateId);
      }
    }
  }

  private async getSnapshotCount(aggregateId: AID) {
    const request: QueryCommandInput = {
      TableName: this.snapshotTableName,
      IndexName: this.snapshotAidIndexName,
      KeyConditionExpression: "#aid = :aid",
      ExpressionAttributeNames: {
        "#aid": "aid",
      },
      ExpressionAttributeValues: {
        ":aid": { S: aggregateId.asString() },
      },
      Select: "COUNT",
    };
    const queryResult = await this.dynamodbClient.send(
      new QueryCommand(request),
    );
    return queryResult.Count;
  }

  private async getLastSnapshotKeys(aggregateId: AID, limit: number) {
    const names = {
      "#aid": "aid",
      "#seq_nr": "seq_nr",
    };
    const values = {
      ":aid": { S: aggregateId.asString() },
      ":seq_nr": { N: "0" },
    };
    const request: QueryCommandInput = {
      TableName: this.snapshotTableName,
      IndexName: this.snapshotAidIndexName,
      KeyConditionExpression: "#aid = :aid AND #seq_nr > :seq_nr",
      ExpressionAttributeNames: { ...names },
      ExpressionAttributeValues: { ...values },
      ScanIndexForward: false,
      Limit: limit,
    };
    if (this.deleteTtl !== undefined) {
      request.FilterExpression = "#ttl = :ttl";
      request.ExpressionAttributeNames = {
        ...names,
        "#ttl": "ttl",
      };
      request.ExpressionAttributeValues = {
        ...values,
        ":ttl": { N: "0" },
      };
    }
    const queryResult = await this.dynamodbClient.send(
      new QueryCommand(request),
    );
    if (queryResult.Items === undefined || queryResult.Items.length === 0) {
      return undefined;
    } else {
      return queryResult.Items.map((item) => {
        const pkey = item.pkey.S;
        const skey = item.skey.S;
        if (pkey === undefined || skey === undefined) {
          throw new Error("pkey or skey is undefined");
        }
        return { pkey, skey };
      });
    }
  }

  private async updateTtlOfExcessSnapshots(aggregateId: AID) {
    if (this.keepSnapshotCount !== undefined && this.deleteTtl !== undefined) {
      let snapshotCount = await this.getSnapshotCount(aggregateId);
      if (snapshotCount === undefined) {
        return undefined;
      }
      snapshotCount -= 1;
      const excessCount = snapshotCount - this.keepSnapshotCount;
      if (excessCount > 0) {
        const keys = await this.getLastSnapshotKeys(aggregateId, excessCount);
        if (keys === undefined) {
          return undefined;
        }
        const ttl = moment().add(this.deleteTtl);
        const result = keys.map((key) => {
          const request: UpdateItemInput = {
            TableName: this.snapshotTableName,
            Key: {
              pkey: { S: key.pkey },
              skey: { S: key.skey },
            },
            UpdateExpression: "SET #ttl = :ttl",
            ExpressionAttributeNames: {
              "#ttl": "ttl",
            },
            ExpressionAttributeValues: {
              ":ttl": { N: ttl.seconds().toString() },
            },
          };
          return this.dynamodbClient
            .send(new UpdateItemCommand(request))
            .then((_) => {});
        });
        return await Promise.all(result);
      }
    }
    return undefined;
  }

  private async deleteExcessSnapshots(aggregateId: AID) {
    if (this.keepSnapshotCount !== undefined && this.deleteTtl !== undefined) {
      let snapshotCount = await this.getSnapshotCount(aggregateId);
      if (snapshotCount === undefined) {
        return undefined;
      }
      snapshotCount -= 1;
      const excessCount = snapshotCount - this.keepSnapshotCount;
      if (excessCount > 0) {
        const keys = await this.getLastSnapshotKeys(aggregateId, excessCount);
        if (keys === undefined) {
          return undefined;
        }
        const request = keys.map((key) => {
          const request: WriteRequest = {
            DeleteRequest: {
              Key: {
                pkey: { S: key.pkey },
                skey: { S: key.skey },
              },
            },
          };
          return request;
        });
        return this.dynamodbClient
          .send(
            new BatchWriteItemCommand({
              RequestItems: {
                [this.snapshotTableName]: request,
              },
            }),
          )
          .then((_) => {});
      }
    }
    return undefined;
  }
}

export { EventStoreForDynamoDB };
