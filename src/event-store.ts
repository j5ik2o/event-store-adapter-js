import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type moment from "moment";
import type { EventStoreWithOptions } from "./event-store-with-options";
import { DefaultKeyResolver } from "./internal/default-key-resolver";
import {
  JsonEventSerializer,
  JsonSnapshotSerializer,
} from "./internal/default-serializer";
import { EventStoreForDynamoDB } from "./internal/event-store-for-dynamodb";
import { EventStoreForMemory } from "./internal/event-store-for-memory";
import type {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  Logger,
  SnapshotSerializer,
} from "./types";

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
    logger: Logger | undefined = undefined,
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
      logger,
    );
  }
  static ofMemory<
    AID extends AggregateId,
    A extends Aggregate<A, AID>,
    E extends Event<AID>,
  >(
    events: Map<AID, E[]> = new Map(),
    snapshots: Map<AID, A> = new Map(),
  ): EventStore<AID, A, E> {
    return new EventStoreForMemory(events, snapshots);
  }
}

export { type EventStore, EventStoreFactory };
