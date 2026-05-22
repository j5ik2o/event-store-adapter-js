import {
  type AttributeValue,
  BatchWriteItemCommand,
  type BatchWriteItemCommandOutput,
  ConditionalCheckFailedException,
  type DynamoDBClient,
  QueryCommand,
  type QueryCommandInput,
  UpdateItemCommand,
  type UpdateItemInput,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type { AggregateId } from "../types";
import { normalizeDynamoDBDeleteTtlMillis } from "./dynamodb-delete-ttl-millis";

type SnapshotKey = {
  pkey: string;
  skey: string;
};

const MAX_BATCH_WRITE_ITEM_COUNT = 25;
const MAX_TTL_UPDATE_CONCURRENCY = 25;
// Match BatchWrite retry budget for consistent retention behavior.
const MAX_TTL_UPDATE_RETRY_COUNT = 5;
const EXCESS_SNAPSHOT_QUERY_LIMIT = 1000;
// Keep retention bounded while allowing short DynamoDB throttle bursts to clear.
const MAX_UNPROCESSED_ITEM_RETRY_COUNT = 5;
const RETENTION_RETRY_BASE_DELAY_MILLIS = 50;
const MILLIS_PER_SECOND = 1000;
const MAX_DYNAMODB_TTL_EPOCH_SECONDS = 9_999_999_999;
const RETRYABLE_DYNAMODB_ERROR_NAMES = new Set([
  "InternalServerError",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ServiceUnavailable",
  "ThrottlingException",
]);

class DynamoDBSnapshotRetentionExecutor<AID extends AggregateId> {
  constructor(
    private dynamodbClient: DynamoDBClient,
    private snapshotTableName: string,
    private snapshotAidIndexName: string,
    private snapshotActiveTtlIndexName: string,
  ) {}

  async purgeExcessSnapshots(
    aggregateId: AID,
    keepSnapshotCount: number | undefined,
    deleteTtlMillis: number | undefined,
  ): Promise<void> {
    if (keepSnapshotCount === undefined) {
      return;
    }
    const keepCount = this.normalizeKeepSnapshotCount(keepSnapshotCount);
    const normalizedDeleteTtlMillis =
      normalizeDynamoDBDeleteTtlMillis(deleteTtlMillis);
    if (normalizedDeleteTtlMillis === undefined) {
      await this.deleteExcessSnapshots(aggregateId, keepCount);
      return;
    }
    await this.updateTtlOfExcessSnapshots(
      aggregateId,
      keepCount,
      normalizedDeleteTtlMillis,
    );
  }

  private normalizeKeepSnapshotCount(keepSnapshotCount: number): number {
    if (!Number.isFinite(keepSnapshotCount)) {
      throw new Error(
        `keepSnapshotCount must be finite, got ${keepSnapshotCount}`,
      );
    }
    return Math.max(0, Math.floor(keepSnapshotCount));
  }

  private async getExcessSnapshotKeys(
    aggregateId: AID,
    keepCount: number,
    onlyActiveTtl: boolean,
  ): Promise<SnapshotKey[]> {
    const excessKeys: SnapshotKey[] = [];
    const keptKeys: SnapshotKey[] = [];
    let nextKeptKeyIndex = 0;
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const request = this.createSnapshotKeyQuery(
        aggregateId,
        onlyActiveTtl,
        exclusiveStartKey,
      );
      const queryResult = await this.dynamodbClient.send(
        new QueryCommand(request),
      );
      if (queryResult.Items !== undefined) {
        for (const key of queryResult.Items.map((item) =>
          this.toSnapshotKey(item),
        )) {
          if (keepCount === 0) {
            excessKeys.push(key);
            continue;
          }
          if (keptKeys.length < keepCount) {
            keptKeys.push(key);
            continue;
          }
          const excessKey = keptKeys[nextKeptKeyIndex];
          keptKeys[nextKeptKeyIndex] = key;
          nextKeptKeyIndex = (nextKeptKeyIndex + 1) % keepCount;
          excessKeys.push(excessKey);
        }
      }
      exclusiveStartKey = queryResult.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return excessKeys;
  }

  private createSnapshotKeyQuery(
    aggregateId: AID,
    onlyActiveTtl: boolean,
    exclusiveStartKey: Record<string, AttributeValue> | undefined,
  ): QueryCommandInput {
    const names: Record<string, string> = onlyActiveTtl
      ? {
          "#active_ttl_seq_nr": "active_ttl_seq_nr",
          "#aid": "aid",
          "#pkey": "pkey",
          "#skey": "skey",
        }
      : {
          "#aid": "aid",
          "#pkey": "pkey",
          "#seq_nr": "seq_nr",
          "#skey": "skey",
        };
    const values = {
      ":aid": { S: aggregateId.asString() },
      ":seq_nr": { N: "0" },
    };
    return {
      TableName: this.snapshotTableName,
      IndexName: onlyActiveTtl
        ? this.snapshotActiveTtlIndexName
        : this.snapshotAidIndexName,
      KeyConditionExpression: onlyActiveTtl
        ? "#aid = :aid AND #active_ttl_seq_nr > :seq_nr"
        : "#aid = :aid AND #seq_nr > :seq_nr",
      ProjectionExpression: "#pkey, #skey",
      ScanIndexForward: true,
      ExclusiveStartKey: exclusiveStartKey,
      Limit: EXCESS_SNAPSHOT_QUERY_LIMIT,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };
  }

  private toSnapshotKey(item: Record<string, AttributeValue>): SnapshotKey {
    const pkey = item.pkey.S;
    const skey = item.skey.S;
    if (pkey === undefined || skey === undefined) {
      throw new Error("pkey or skey is undefined");
    }
    return { pkey, skey };
  }

  private async updateTtlOfExcessSnapshots(
    aggregateId: AID,
    keepSnapshotCount: number,
    deleteTtlMillis: number,
  ): Promise<void> {
    const keys = await this.getExcessSnapshotKeys(
      aggregateId,
      keepSnapshotCount,
      true,
    );
    if (keys.length === 0) {
      return;
    }
    const ttl = this.toDeleteTtlEpochSeconds(deleteTtlMillis);
    await this.sendUpdateTtlRequests(keys, ttl);
  }

  private toDeleteTtlEpochSeconds(deleteTtlMillis: number): string {
    const nowMillis = Date.now();
    if (deleteTtlMillis > Number.MAX_SAFE_INTEGER - nowMillis) {
      throw new Error(
        "TTL calculation overflow: Date.now() + deleteTtlMillis exceeds safe integer range",
      );
    }
    const ttlEpochMillis = nowMillis + deleteTtlMillis;
    // DynamoDB TTL is epoch seconds; round up so millisecond TTLs do not expire earlier than requested.
    const ttlEpochSeconds = Math.ceil(ttlEpochMillis / MILLIS_PER_SECOND);
    if (ttlEpochSeconds > MAX_DYNAMODB_TTL_EPOCH_SECONDS) {
      throw new Error(
        "TTL calculation overflow: epoch seconds exceed DynamoDB TTL range",
      );
    }
    return ttlEpochSeconds.toString();
  }

  private async sendUpdateTtlRequests(
    keys: SnapshotKey[],
    ttl: string,
  ): Promise<void> {
    const failures: unknown[] = [];
    let nextKeyIndex = 0;
    const workerCount = Math.min(keys.length, MAX_TTL_UPDATE_CONCURRENCY);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextKeyIndex < keys.length) {
          const key = keys[nextKeyIndex];
          nextKeyIndex += 1;
          try {
            await this.sendUpdateTtlRequest(
              this.createUpdateTtlRequest(key, ttl),
            );
          } catch (e) {
            failures.push(e);
          }
        }
      }),
    );
    if (failures.length > 0) {
      throw this.createSnapshotRetentionError(
        `Failed to update TTL for ${failures.length} snapshot items`,
        failures,
      );
    }
  }

  private createSnapshotRetentionError(
    message: string,
    failures: unknown[],
  ): Error {
    if (typeof AggregateError === "function") {
      return new AggregateError(failures, message);
    }
    const error = new Error(message) as Error & { errors: unknown[] };
    error.errors = failures;
    return error;
  }

  private createUpdateTtlRequest(
    key: SnapshotKey,
    ttl: string,
  ): UpdateItemInput {
    return {
      TableName: this.snapshotTableName,
      Key: {
        pkey: { S: key.pkey },
        skey: { S: key.skey },
      },
      ExpressionAttributeNames: {
        "#active_ttl_seq_nr": "active_ttl_seq_nr",
        "#ttl": "ttl",
      },
      ExpressionAttributeValues: {
        ":ttl": { N: ttl },
      },
      UpdateExpression: "SET #ttl = :ttl REMOVE #active_ttl_seq_nr",
      ConditionExpression: "attribute_exists(pkey)",
    };
  }

  private async deleteExcessSnapshots(
    aggregateId: AID,
    keepSnapshotCount: number,
  ): Promise<void> {
    const keys = await this.getExcessSnapshotKeys(
      aggregateId,
      keepSnapshotCount,
      false,
    );
    if (keys.length === 0) {
      return;
    }
    const requests: WriteRequest[] = keys.map((key) => {
      return {
        DeleteRequest: {
          Key: {
            pkey: { S: key.pkey },
            skey: { S: key.skey },
          },
        },
      };
    });
    await this.batchWriteDeleteRequests(requests);
  }

  private async batchWriteDeleteRequests(
    requests: WriteRequest[],
  ): Promise<void> {
    for (
      let index = 0;
      index < requests.length;
      index += MAX_BATCH_WRITE_ITEM_COUNT
    ) {
      await this.batchWriteDeleteRequestChunk(
        requests.slice(index, index + MAX_BATCH_WRITE_ITEM_COUNT),
      );
    }
  }

  private async batchWriteDeleteRequestChunk(
    requests: WriteRequest[],
  ): Promise<void> {
    let unprocessedRequests = requests;
    for (
      let retryCount = 0;
      unprocessedRequests.length > 0 &&
      retryCount <= MAX_UNPROCESSED_ITEM_RETRY_COUNT;
      retryCount++
    ) {
      if (retryCount > 0) {
        await this.waitBeforeRetry(retryCount);
      }
      const output =
        await this.sendBatchWriteDeleteRequests(unprocessedRequests);
      unprocessedRequests =
        output.UnprocessedItems?.[this.snapshotTableName] ?? [];
    }
    if (unprocessedRequests.length > 0) {
      throw new Error(
        `Failed to delete ${unprocessedRequests.length} snapshot items after ${MAX_UNPROCESSED_ITEM_RETRY_COUNT} retries`,
      );
    }
  }

  private async waitBeforeRetry(retryCount: number): Promise<void> {
    const delayMillis =
      RETENTION_RETRY_BASE_DELAY_MILLIS * 2 ** (retryCount - 1) +
      Math.floor(Math.random() * RETENTION_RETRY_BASE_DELAY_MILLIS);
    await new Promise((resolve) => setTimeout(resolve, delayMillis));
  }

  private async sendBatchWriteDeleteRequests(
    requests: WriteRequest[],
  ): Promise<BatchWriteItemCommandOutput> {
    return await this.dynamodbClient.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [this.snapshotTableName]: requests,
        },
      }),
    );
  }

  private async sendUpdateTtlRequest(request: UpdateItemInput): Promise<void> {
    for (
      let retryCount = 0;
      retryCount <= MAX_TTL_UPDATE_RETRY_COUNT;
      retryCount++
    ) {
      if (retryCount > 0) {
        await this.waitBeforeRetry(retryCount);
      }
      try {
        await this.dynamodbClient.send(new UpdateItemCommand(request));
        return;
      } catch (e) {
        if (e instanceof ConditionalCheckFailedException) {
          // The snapshot was already removed, so there is no TTL update left to apply.
          return;
        }
        if (
          retryCount < MAX_TTL_UPDATE_RETRY_COUNT &&
          this.isRetryableDynamoDBError(e)
        ) {
          continue;
        }
        throw e;
      }
    }
  }

  private isRetryableDynamoDBError(e: unknown): boolean {
    if (typeof e !== "object" || e === null) {
      return false;
    }
    const retryable = (e as { $retryable?: unknown }).$retryable;
    if (typeof retryable === "object" && retryable !== null) {
      const throttling = (retryable as { throttling?: unknown }).throttling;
      return throttling !== false;
    }
    const name = (e as { name?: unknown }).name;
    return typeof name === "string" && RETRYABLE_DYNAMODB_ERROR_NAMES.has(name);
  }
}

export { DynamoDBSnapshotRetentionExecutor };
