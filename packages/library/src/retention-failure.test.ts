import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "./dynamodb-event-store-input";
import type { Logger } from "./logger";
import type { MemoryEventStoreInput } from "./memory-event-store-input";
import type { MemoryStorage } from "./memory-storage";
import type { MemoryStorageInput } from "./memory-storage-input";
import type { PayloadSerializer } from "./payload-serializer";
import type { RetentionFailure } from "./retention-failure";
import type { SnapshotRetention } from "./snapshot-retention";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

test("configuration input and failure types match design 2.9", () => {
  const retention: Equal<
    SnapshotRetention,
    Readonly<{
      count: number;
      mode?: { type: "delete" } | { type: "ttl"; graceSeconds: number };
    }>
  > = true;
  const failure: Equal<
    RetentionFailure,
    Readonly<{
      kind: "retention-failure";
      aggregateId: string;
      cause: unknown;
    }>
  > = true;
  const storage: Equal<
    MemoryStorageInput,
    Readonly<{
      retention?: SnapshotRetention;
      changeFeed?: unknown;
    }>
  > = true;
  const memory: Equal<
    MemoryEventStoreInput<string, number>,
    Readonly<{
      storage?: MemoryStorage;
      eventSerializer?: PayloadSerializer<string>;
      snapshotSerializer?: PayloadSerializer<number>;
      onRetentionFailure?: (failure: RetentionFailure) => void;
      logger?: Logger;
    }>
  > = true;
  const dynamodb: Equal<
    DynamoDBEventStoreInput<string, number>,
    Readonly<{
      client: DynamoDBClient;
      tables: Readonly<{ journal: string; snapshot: string; head: string }>;
      snapshotAidIndexName: string;
      eventSerializer?: PayloadSerializer<string>;
      snapshotSerializer?: PayloadSerializer<number>;
      retention?: SnapshotRetention;
      onRetentionFailure?: (failure: RetentionFailure) => void;
      logger?: Logger;
      retryLimit?: number;
    }>
  > = true;

  expect([retention, failure, storage, memory, dynamodb]).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
});
