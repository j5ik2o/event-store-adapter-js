import {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  SnapshotSerializer,
} from "../types";
import { EventStore } from "../event-store";
import {
  DynamoDBClient,
  Put,
  TransactWriteItem,
  TransactWriteItemsCommand,
  TransactWriteItemsInput,
  Update,
} from "@aws-sdk/client-dynamodb";

class EventStoreForDynamoDB<
  AID extends AggregateId,
  A extends Aggregate<AID>,
  E extends Event<AID>,
> implements EventStore<AID, A, E>
{
  constructor(
    private dynamodbClient: DynamoDBClient,
    private journalTableName: string,
    private snapshotTableName: string,
    private journalAidIndexName: string,
    private snapshotAidIndexName: string,
    private shardCount: number,
    private keepSnapshotCount: number,
    private deleteTtl: moment.Duration,
    private keyResolver: KeyResolver<AID>,
    private eventSerializer: EventSerializer<AID, E>,
    private snapshotSerializer: SnapshotSerializer<AID, A>,
  ) {}

  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]> {
    return Promise.resolve([]);
  }

  getLatestSnapshotById(id: AID): Promise<A | undefined> {
    return Promise.resolve(undefined);
  }

  persistEvent(event: E, version: number): Promise<void> {
    if (event.isCreated()) {
      throw new Error("Cannot persist created event");
    }
    return this.updateEventAndSnapshotOpt(event, version, undefined);
  }

  private async updateEventAndSnapshotOpt(
    event: E,
    version: number,
    aggregate: A | undefined,
  ) {
    const put = this.putJournal(event);
    const update = this.updateSnapshot(event, 0, version, aggregate);
    const transactWriteItem: TransactWriteItem = {
      Update: update,
      Put: put,
    };
    const input: TransactWriteItemsInput = {
      TransactItems: [transactWriteItem],
    };
    return this.dynamodbClient
      .send(new TransactWriteItemsCommand(input))
      .then(() => Promise.resolve());
  }
  //
  // private updateSnapshot(
  //   event: E,
  //   sequenceNumber: number,
  //   version: number,
  //   aggregate: A | undefined,
  // ) {}

  private putJournal(event: E): Put {
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId(),
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId(),
      event.sequenceNumber(),
    );
    const payload = this.eventSerializer.serialize(event);
    return {
      TableName: this.journalTableName,
      Item: {
        pkey: { S: pkey },
        skey: { S: skey },
        aid: { S: event.aggregateId().asString() },
        seq_nr: { N: event.sequenceNumber().toString() },
        payload: { B: payload },
        occurred_at: { N: event.occurredAt().getUTCMilliseconds().toString() },
      },
      ConditionExpression:
        "attribute_not_exists(pkey) AND attribute_not_exists(skey)",
    };
  }

  private putSnapshot(event: E, seqNr: number, aggregate: A): Put {
    const pkey = this.keyResolver.resolvePartitionKey(
      event.aggregateId(),
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId(),
      event.sequenceNumber(),
    );
    const payload = this.snapshotSerializer.serialize(aggregate);
    return {
      TableName: this.snapshotTableName,
      Item: {
        pkey: { S: pkey },
        skey: { S: skey },
        aid: { S: event.aggregateId().asString() },
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
      event.aggregateId(),
      this.shardCount,
    );
    const skey = this.keyResolver.resolveSortKey(
      event.aggregateId(),
      event.sequenceNumber(),
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

  persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    return Promise.resolve(undefined);
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
}
