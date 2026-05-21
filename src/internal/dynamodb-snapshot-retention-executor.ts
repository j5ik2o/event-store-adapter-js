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
import moment from "moment/moment";
import type { AggregateId } from "../types";

type SnapshotKey = {
  pkey: string;
  skey: string;
};

const MAX_BATCH_WRITE_ITEM_COUNT = 25;
const MAX_TTL_UPDATE_CONCURRENCY = 25;
// Keep retention bounded while allowing short DynamoDB throttle bursts to clear.
const MAX_UNPROCESSED_ITEM_RETRY_COUNT = 5;
const UNPROCESSED_ITEM_RETRY_BASE_DELAY_MILLIS = 50;

class DynamoDBSnapshotRetentionExecutor<AID extends AggregateId> {
  constructor(
    private dynamodbClient: DynamoDBClient,
    private snapshotTableName: string,
    private snapshotAidIndexName: string,
  ) {}

  async purgeExcessSnapshots(
    aggregateId: AID,
    keepSnapshotCount: number | undefined,
    deleteTtl: moment.Duration | undefined,
  ): Promise<void> {
    if (keepSnapshotCount === undefined) {
      return;
    }
    if (deleteTtl === undefined) {
      await this.deleteExcessSnapshots(aggregateId, keepSnapshotCount);
      return;
    }
    await this.updateTtlOfExcessSnapshots(
      aggregateId,
      keepSnapshotCount,
      deleteTtl,
    );
  }

  private async getExcessSnapshotKeys(
    aggregateId: AID,
    keepSnapshotCount: number,
    onlyActiveTtl: boolean,
  ): Promise<SnapshotKey[]> {
    const keys: SnapshotKey[] = [];
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
        keys.push(...queryResult.Items.map((item) => this.toSnapshotKey(item)));
      }
      exclusiveStartKey = queryResult.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return keys.slice(0, Math.max(0, keys.length - keepSnapshotCount));
  }

  private createSnapshotKeyQuery(
    aggregateId: AID,
    onlyActiveTtl: boolean,
    exclusiveStartKey: Record<string, AttributeValue> | undefined,
  ): QueryCommandInput {
    const names = {
      "#aid": "aid",
      "#pkey": "pkey",
      "#seq_nr": "seq_nr",
      "#skey": "skey",
    };
    const values = {
      ":aid": { S: aggregateId.asString() },
      ":seq_nr": { N: "0" },
    };
    const activeTtlAttributes = onlyActiveTtl
      ? {
          FilterExpression: "#ttl = :ttl",
          ExpressionAttributeNames: {
            ...names,
            "#ttl": "ttl",
          },
          ExpressionAttributeValues: {
            ...values,
            ":ttl": { N: "0" },
          },
        }
      : {
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        };
    return {
      TableName: this.snapshotTableName,
      IndexName: this.snapshotAidIndexName,
      KeyConditionExpression: "#aid = :aid AND #seq_nr > :seq_nr",
      ProjectionExpression: "#pkey, #skey",
      ScanIndexForward: true,
      ExclusiveStartKey: exclusiveStartKey,
      ...activeTtlAttributes,
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
    deleteTtl: moment.Duration,
  ): Promise<void> {
    const keys = await this.getExcessSnapshotKeys(
      aggregateId,
      keepSnapshotCount,
      true,
    );
    if (keys.length === 0) {
      return;
    }
    const ttl = moment().add(deleteTtl).unix().toString();
    for (
      let index = 0;
      index < keys.length;
      index += MAX_TTL_UPDATE_CONCURRENCY
    ) {
      await Promise.all(
        keys.slice(index, index + MAX_TTL_UPDATE_CONCURRENCY).map((key) => {
          const request: UpdateItemInput = {
            TableName: this.snapshotTableName,
            Key: {
              pkey: { S: key.pkey },
              skey: { S: key.skey },
            },
            UpdateExpression: "SET #ttl = :ttl",
            ExpressionAttributeNames: {
              "#ttl": "ttl",
            },
            ExpressionAttributeValues: {
              ":ttl": { N: ttl },
            },
            ConditionExpression: "attribute_exists(pkey)",
          };
          return this.sendUpdateTtlRequest(request);
        }),
      );
    }
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
      UNPROCESSED_ITEM_RETRY_BASE_DELAY_MILLIS * 2 ** (retryCount - 1) +
      Math.floor(Math.random() * UNPROCESSED_ITEM_RETRY_BASE_DELAY_MILLIS);
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
    try {
      await this.dynamodbClient.send(new UpdateItemCommand(request));
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        // The snapshot was already removed, so there is no TTL update left to apply.
        return;
      }
      throw e;
    }
  }
}

export { DynamoDBSnapshotRetentionExecutor };
