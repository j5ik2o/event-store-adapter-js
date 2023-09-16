import {Aggregate, AggregateId, Event, EventSerializer, KeyResolver, SnapshotSerializer,} from "../types";
import {EventStore} from "../event-store";
import {
  DynamoDBClient,
  Put,
  QueryCommand,
  QueryCommandInput,
  TransactWriteItemsCommand,
  TransactWriteItemsInput,
  Update,
} from "@aws-sdk/client-dynamodb";
import * as moment from "moment/moment";
import {DefaultKeyResolver} from "./default-key-resolver";
import {JsonEventSerializer, JsonSnapshotSerializer,} from "./default-serializer";
import {LoggerFactory} from "./logger-factory";
import * as winston from "winston";

class EventStoreForDynamoDB<
  AID extends AggregateId,
  A extends Aggregate<AID>,
  E extends Event<AID>,
> implements EventStore<AID, A, E>
{
  private logger: winston.Logger;
  constructor(
    private dynamodbClient: DynamoDBClient,
    private journalTableName: string,
    private snapshotTableName: string,
    private journalAidIndexName: string,
    private snapshotAidIndexName: string,
    private shardCount: number,
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
  ) {
    const loggerFactory = new LoggerFactory(process.env.STAGE ?? "dev");
    this.logger = loggerFactory.createLogger();
  }

  async getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]> {
    const request: QueryCommandInput = {
      TableName: this.journalTableName,
      IndexName: this.journalAidIndexName,
      KeyConditionExpression: "#aid = :aid AND #seq_nr >= :seq_nr",
      ExpressionAttributeNames: {
        "#aid": "aid",
        "#seq_nr": "seq_nr",
      },
      ExpressionAttributeValues: {
        ":aid": { S: id.asString },
        ":seq_nr": { N: sequenceNumber.toString() },
      },
    };
    const result = await this.dynamodbClient.send(new QueryCommand(request));
    if (result.Items === undefined) {
      return Promise.resolve([]);
    } else {
      return Promise.resolve(
        result.Items.map((item) => {
          const payload = item.payload.B;
          if (payload === undefined) {
            throw new Error("Payload is undefined");
          }
          return this.eventSerializer.deserialize(payload, "event");
        }),
      );
    }
  }

  async getLatestSnapshotById(id: AID, converter: (json: string) => A): Promise<A | undefined> {
    const request: QueryCommandInput = {
      TableName: this.snapshotTableName,
      IndexName: this.snapshotAidIndexName,
      KeyConditionExpression: "#aid = :aid AND #seq_nr = :seq_nr",
      ExpressionAttributeNames: {
        "#aid": "aid",
        "#seq_nr": "seq_nr",
      },
      ExpressionAttributeValues: {
        ":aid": { S: id.asString },
        ":seq_nr": { N: "0" },
      },
      Limit: 1,
    };
    const queryResult = await this.dynamodbClient.send(new QueryCommand(request));
    if (queryResult.Items === undefined || queryResult.Items.length === 0) {
      return undefined;
    } else {
      const item = queryResult.Items[0];
      const payload = item.payload.B;
      if (payload === undefined) {
        throw new Error("Payload is undefined");
      }
      this.logger.info("payload: " + JSON.stringify(payload));
      const result = this.snapshotSerializer.deserialize(
          payload,
          converter,
      );
      this.logger.info("result: " + JSON.stringify(result));
      return result;
    }
  }

  async persistEvent(event: E, version: number): Promise<void> {
    this.logger.info(`persistEvent(${event}, ${version}): start`);
    if (event.isCreated) {
      throw new Error("Cannot persist created event");
    }
    const result = this.updateEventAndSnapshotOpt(event, version, undefined);
    this.logger.info(`persistEvent(${event}, ${version}): finished`);
    return result
  }

  async persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    this.logger.info(`persistEventAndSnapshot(${event}, ${aggregate}): start`);
    if (event.isCreated) {
      const result = this.createEventAndSnapshot(event, aggregate);
      this.logger.info(`persistEventAndSnapshot(${event}, ${aggregate}): finished`);
      return result;
    } else {
      const result = this.updateEventAndSnapshotOpt(
        event,
        aggregate.sequenceNumber,
        aggregate,
      );
      this.logger.info(`persistEventAndSnapshot(${event}, ${aggregate}): finished`);
      return result;
    }
  }

  withDeleteTtl(deleteTtl: moment.Duration): EventStore<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.keepSnapshotCount,
      deleteTtl,
      this.keyResolver,
      this.eventSerializer,
      this.snapshotSerializer,
    );
  }

  withEventSerializer(
    eventSerializer: EventSerializer<AID, E>,
  ): EventStore<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.keepSnapshotCount,
      this.deleteTtl,
      this.keyResolver,
      eventSerializer,
      this.snapshotSerializer,
    );
  }

  withKeepSnapshotCount(keepSnapshotCount: number): EventStore<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      keepSnapshotCount,
      this.deleteTtl,
      this.keyResolver,
      this.eventSerializer,
      this.snapshotSerializer,
    );
  }

  withKeyResolver(keyResolver: KeyResolver<AID>): EventStore<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.keepSnapshotCount,
      this.deleteTtl,
      keyResolver,
      this.eventSerializer,
      this.snapshotSerializer,
    );
  }

  withSnapshotSerializer(
    snapshotSerializer: SnapshotSerializer<AID, A>,
  ): EventStore<AID, A, E> {
    return new EventStoreForDynamoDB(
      this.dynamodbClient,
      this.journalTableName,
      this.snapshotTableName,
      this.journalAidIndexName,
      this.snapshotAidIndexName,
      this.shardCount,
      this.keepSnapshotCount,
      this.deleteTtl,
      this.keyResolver,
      this.eventSerializer,
      snapshotSerializer,
    );
  }

  private async createEventAndSnapshot(event: E, aggregate: A) {
    const putJournal = this.putJournal(event);
    const putSnapshot = this.putSnapshot(event, 0, aggregate);
    const transactWriteItems = [
      {
        Put: putJournal,
      },
      {
        Put: putSnapshot,
      },
    ];
    const input: TransactWriteItemsInput = {
      TransactItems: transactWriteItems,
    };
    await this.dynamodbClient
      .send(new TransactWriteItemsCommand(input));
  }

  private async updateEventAndSnapshotOpt(
    event: E,
    version: number,
    aggregate: A | undefined,
  ) {
    const put = this.putJournal(event);
    const update = this.updateSnapshot(event, 0, version, aggregate);
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
    await this.dynamodbClient
      .send(new TransactWriteItemsCommand(input));
  }

  private putJournal(event: E): Put {
    console.log("putJournal: event = ", event);
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId,
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId,
      event.sequenceNumber,
    );
    const payload = this.eventSerializer.serialize(event);
    return {
      TableName: this.journalTableName,
      Item: {
        pkey: { S: pkey },
        skey: { S: skey },
        aid: { S: event.aggregateId.asString },
        seq_nr: { N: event.sequenceNumber.toString() },
        payload: { B: payload },
        occurred_at: { N: event.occurredAt.getUTCMilliseconds().toString() },
      },
      ConditionExpression:
        "attribute_not_exists(pkey) AND attribute_not_exists(skey)",
    };
  }

  private putSnapshot(event: E, seqNr: number, aggregate: A): Put {
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId,
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId,
      event.sequenceNumber,
    );
    const payload = this.snapshotSerializer.serialize(aggregate);
    return {
      TableName: this.snapshotTableName,
      Item: {
        pkey: { S: pkey },
        skey: { S: skey },
        aid: { S: event.aggregateId.asString },
        seq_nr: { N: seqNr.toString() },
        payload: { B: payload },
        version: { N: "1" },
        ttl: { N: "0" },
      },
    };
  }

  private updateSnapshot(
    event: E,
    seqNr: number,
    version: number,
    aggregate: A | undefined,
  ): Update {
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId,
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId,
      event.sequenceNumber,
    );
    const update: Update = {
      TableName: this.snapshotTableName,
      UpdateExpression: "SET #version=:after_version",
      Key: {
        pkey: { S: pkey },
        skey: { S: skey },
      },
      ExpressionAttributeNames: {
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":before_version": { N: version.toString() },
        ":after_version": { N: (version + 1).toString() },
      },
      ConditionExpression: "#version=:before_version",
    };
    if (aggregate !== undefined) {
      const payload = this.snapshotSerializer.serialize(aggregate);
      update.UpdateExpression =
        "SET #payload=:payload, #seq_nr=:seq_nr, #version=:after_version";
      if (!update.ExpressionAttributeNames) {
        update.ExpressionAttributeNames = {};
      }
      if (!update.ExpressionAttributeValues) {
        update.ExpressionAttributeValues = {};
      }
      update.ExpressionAttributeNames["#seq_nr"] = "seq_nr";
      update.ExpressionAttributeNames["#payload"] = "payload";
      update.ExpressionAttributeValues[":seq_nr"] = { N: seqNr.toString() };
      update.ExpressionAttributeValues[":payload"] = { B: payload };
    }
    return update;
  }
}

export { EventStoreForDynamoDB };
