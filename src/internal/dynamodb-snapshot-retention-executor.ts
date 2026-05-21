import {
  type AttributeValue,
  BatchWriteItemCommand,
  type BatchWriteItemCommandOutput,
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
const MAX_UNPROCESSED_ITEM_RETRY_COUNT = 3;

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

  private async getSnapshotCount(aggregateId: AID): Promise<number> {
    let count = 0;
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const request: QueryCommandInput = {
        TableName: this.snapshotTableName,
        IndexName: this.snapshotAidIndexName,
        KeyConditionExpression: "#aid = :aid",
        ExpressionAttributeNames: {
          "#aid": "aid",
        },
        ExpressionAttributeValues: {
          ":aid": { S: aggregateId.asString() },
        },
        Select: "COUNT",
        ExclusiveStartKey: exclusiveStartKey,
      };
      const queryResult = await this.dynamodbClient.send(
        new QueryCommand(request),
      );
      count += queryResult.Count ?? 0;
      exclusiveStartKey = queryResult.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return count;
  }

  private async getOldestSnapshotKeys(
    aggregateId: AID,
    limit: number,
    onlyActiveTtl: boolean,
  ): Promise<SnapshotKey[]> {
    const result: SnapshotKey[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const request = this.createSnapshotKeyQuery(
        aggregateId,
        limit - result.length,
        onlyActiveTtl,
        exclusiveStartKey,
      );
      const queryResult = await this.dynamodbClient.send(
        new QueryCommand(request),
      );
      if (queryResult.Items !== undefined) {
        result.push(
          ...queryResult.Items.map((item) => this.toSnapshotKey(item)),
        );
      }
      exclusiveStartKey = queryResult.LastEvaluatedKey;
    } while (result.length < limit && exclusiveStartKey !== undefined);
    return result;
  }

  private createSnapshotKeyQuery(
    aggregateId: AID,
    limit: number,
    onlyActiveTtl: boolean,
    exclusiveStartKey: Record<string, AttributeValue> | undefined,
  ): QueryCommandInput {
    const names = {
      "#aid": "aid",
      "#seq_nr": "seq_nr",
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
      ScanIndexForward: true,
      Limit: limit,
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
    const excessCount = await this.getExcessSnapshotCount(
      aggregateId,
      keepSnapshotCount,
    );
    if (excessCount <= 0) {
      return;
    }
    const keys = await this.getOldestSnapshotKeys(
      aggregateId,
      excessCount,
      true,
    );
    if (keys.length === 0) {
      return;
    }
    const ttl = moment().add(deleteTtl).unix().toString();
    await Promise.all(
      keys.map((key) => {
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
        };
        return this.dynamodbClient.send(new UpdateItemCommand(request));
      }),
    );
  }

  private async deleteExcessSnapshots(
    aggregateId: AID,
    keepSnapshotCount: number,
  ): Promise<void> {
    const excessCount = await this.getExcessSnapshotCount(
      aggregateId,
      keepSnapshotCount,
    );
    if (excessCount <= 0) {
      return;
    }
    const keys = await this.getOldestSnapshotKeys(
      aggregateId,
      excessCount,
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

  private async getExcessSnapshotCount(
    aggregateId: AID,
    keepSnapshotCount: number,
  ): Promise<number> {
    const snapshotCount = await this.getSnapshotCount(aggregateId);
    return snapshotCount - 1 - keepSnapshotCount;
  }
}

export { DynamoDBSnapshotRetentionExecutor };
