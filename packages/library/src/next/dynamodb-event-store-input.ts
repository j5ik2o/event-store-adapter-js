import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { Logger } from "../logger";
import type { PayloadSerializer } from "./payload-serializer";
import type { RetentionFailure } from "./retention-failure";
import type { SnapshotRetention } from "./snapshot-retention";

export type DynamoDBEventStoreInput<PE, PS> = Readonly<{
  client: DynamoDBClient;
  tables: Readonly<{ journal: string; snapshot: string; head: string }>;
  snapshotAidIndexName: string;
  eventSerializer?: PayloadSerializer<PE>;
  snapshotSerializer?: PayloadSerializer<PS>;
  retention?: SnapshotRetention;
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
  retryLimit?: number;
}>;
