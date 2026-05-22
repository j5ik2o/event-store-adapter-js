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
  /** Converts the deserialized event JSON payload from unknown into an event. */
  eventConverter: (json: unknown) => E;
  /** Converts the deserialized snapshot JSON payload from unknown into an aggregate. */
  snapshotConverter: (json: unknown) => A;
  keepSnapshotCount?: number;
  deleteTtlMillis?: number;
  keyResolver?: KeyResolver<AID>;
  eventSerializer?: EventSerializer<AID, E>;
  snapshotSerializer?: SnapshotSerializer<AID, A>;
  logger?: Logger;
}

export type { DynamoDBEventStoreInput };
