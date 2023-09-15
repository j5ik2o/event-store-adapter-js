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
  getEventsByIdSinceSequenceNumber(id: AID, sequenceNumber: number): E[] {
    return [];
  }

  getLatestSnapshotById(id: AID): A | undefined {
    return undefined;
  }

  persistEvent(event: E, version: number): void {
    if (event.isCreated()) {
      throw new Error("Cannot persist created event");
    }
    this.updateEventAndSnapshotOpt(event, version, undefined);
  }

  private updateEventAndSnapshotOpt(
    event: E,
    version: number,
    aggregate: A | undefined,
  ) {}

  private updateSnapshot(
    event: E,
    sequenceNumber: number,
    version: number,
    aggregate: A | undefined,
  ) {}

  persistEventAndSnapshot(event: E, aggregate: A): void {}

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
