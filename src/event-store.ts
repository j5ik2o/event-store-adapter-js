import {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  SnapshotSerializer,
} from "./types";
import { EventStoreForDynamoDB } from "./internal/event-store-for-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import moment from "moment";
import { DefaultKeyResolver } from "./internal/default-key-resolver";
import {
  JsonEventSerializer,
  JsonSnapshotSerializer,
} from "./internal/default-serializer";
import { EventStoreForMemory } from "./internal/event-store-for-memory";
import { EventStoreWithOptions } from "./event-store-with-options";

interface EventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> {
  persistEvent(event: E, version: number): Promise<void>;
  persistEventAndSnapshot(event: E, aggregate: A): Promise<void>;
  getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]>;
  getLatestSnapshotById(id: AID): Promise<A | undefined>;
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
    eventConverter: (json: string) => E,
    snapshotConverter: (json: string) => A,
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
  ): EventStoreWithOptions<AID, A, E> {
    return new EventStoreForDynamoDB<AID, A, E>(
      dynamodbClient,
      journalTableName,
      snapshotTableName,
      journalAidIndexName,
      snapshotAidIndexName,
      shardCount,
      eventConverter,
      snapshotConverter,
      keepSnapshotCount,
      deleteTtl,
      keyResolver,
      eventSerializer,
      snapshotSerializer,
    );
  }

  static ofMemory<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(events: Map<AID, E[]>, snapshots: Map<AID, A>): EventStore<AID, A, E> {
    return new EventStoreForMemory(events, snapshots);
  }
}

export { EventStore, EventStoreFactory };
