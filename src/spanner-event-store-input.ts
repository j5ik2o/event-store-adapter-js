import type { Database } from "@google-cloud/spanner";
import type { SpannerShardSelector } from "./spanner-shard-selector";
import type {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  Logger,
  SnapshotSerializer,
} from "./types";

interface SpannerEventStoreInput<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> {
  database: Database;
  journalTableName: string;
  snapshotTableName: string;
  shardCount: number;
  /** Converts the deserialized event JSON payload from unknown into an event. */
  eventConverter: (json: unknown) => E;
  /** Converts the deserialized snapshot JSON payload from unknown into an aggregate. */
  snapshotConverter: (json: unknown) => A;
  keepSnapshotCount?: number;
  shardSelector?: SpannerShardSelector<AID>;
  eventSerializer?: EventSerializer<AID, E>;
  snapshotSerializer?: SnapshotSerializer<AID, A>;
  logger?: Logger;
}

export type { SpannerEventStoreInput };
