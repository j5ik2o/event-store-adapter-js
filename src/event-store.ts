import {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  SnapshotSerializer,
} from "./types";
import { EventStoreOptions } from "./event-store-options";
import { EventStoreForDynamoDB } from "./internal/event-store-for-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import * as moment from "moment";
import { DefaultKeyResolver } from "./internal/default-key-resolver";
import {
  JsonEventSerializer,
  JsonSnapshotSerializer,
} from "./internal/default-serializer";

interface EventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> extends EventStoreOptions<EventStore<AID, A, E>, AID, A, E> {
  persistEvent(event: E, version: number): Promise<void>;
  persistEventAndSnapshot(event: E, aggregate: A): Promise<void>;
  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
    converter: (json: string) => E,
  ): Promise<E[]>;
  getLatestSnapshotById(
    id: AID,
    converter: (json: string) => A,
  ): Promise<A | undefined>;
}

class EventStoreFactory {
  static ofDynamoDB<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(
    dynamodbClient: DynamoDBClient,
    journalTableName: string,
    snapshotTableName: string,
    journalAidIndexName: string,
    snapshotAidIndexName: string,
    shardCount: number,
    keepSnapshotCount: number | undefined = undefined,
    deleteTtl: moment.Duration | undefined = undefined,
    keyResolver: KeyResolver<AID> = new DefaultKeyResolver(),
    eventSerializer: EventSerializer<AID, E> = new JsonEventSerializer<
      AID,
      E
    >(),
    snapshotSerializer: SnapshotSerializer<AID, A> = new JsonSnapshotSerializer<
      AID,
      A
    >(),
  ) {
    return new EventStoreForDynamoDB<AID, A, E>(
      dynamodbClient,
      journalTableName,
      snapshotTableName,
      journalAidIndexName,
      snapshotAidIndexName,
      shardCount,
      keepSnapshotCount,
      deleteTtl,
      keyResolver,
      eventSerializer,
      snapshotSerializer,
    );
  }
}

export { EventStore, EventStoreFactory };
