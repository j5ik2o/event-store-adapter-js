import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  Logger,
  SnapshotSerializer,
} from "./types";

interface DynamoDBEventStoreInput<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> {
  client: DynamoDBClient;
  journalTableName: string;
  snapshotTableName: string;
  journalAidIndexName: string;
  snapshotAidIndexName: string;
  snapshotActiveTtlIndexName: string;
  shardCount: number;
  eventConverter: (json: unknown) => E;
  snapshotConverter: (json: unknown) => A;
  keepSnapshotCount?: number;
  deleteTtlMillis?: number;
  keyResolver?: KeyResolver<AID>;
  eventSerializer?: EventSerializer<AID, E>;
  snapshotSerializer?: SnapshotSerializer<AID, A>;
  logger?: Logger;
}

export type { DynamoDBEventStoreInput };
