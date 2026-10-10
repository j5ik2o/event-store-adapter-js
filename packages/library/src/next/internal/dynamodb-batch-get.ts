import {
  type AttributeValue,
  BatchGetItemCommand,
  type BatchGetItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { Result } from "../../result";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import { EventStoreError } from "../event-store-error";

/** 各表に1キーを要求する設定照合と最新読取で、未処理だけを読み切る。 */
export async function readDynamoDBBatch(
  input: Readonly<
    Pick<DynamoDBEventStoreInput<unknown, unknown>, "client"> & {
      retryLimit: number;
    }
  >,
  initialRequest: NonNullable<BatchGetItemCommandInput["RequestItems"]>,
  operation: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<
  Result<Map<string, Record<string, AttributeValue>>, EventStoreError>
> {
  let requestItems = initialRequest;
  let items = new Map<string, Record<string, AttributeValue>>();
  const retryLimit = BigInt(input.retryLimit);
  let retries = BigInt(0);
  try {
    while (true) {
      const response = await input.client.send(
        new BatchGetItemCommand({ RequestItems: requestItems }),
      );
      for (const [tableName, [item]] of Object.entries(
        response.Responses ?? {},
      )) {
        if (item !== undefined) items = new Map([...items, [tableName, item]]);
      }
      requestItems = Object.fromEntries(
        Object.entries(response.UnprocessedKeys ?? {})
          .filter(([, pending]) => (pending.Keys?.length ?? 0) > 0)
          .map(([tableName, pending]) => [
            tableName,
            { ...pending, ConsistentRead: true },
          ]),
      );
      if (Object.keys(requestItems).length === 0) return Result.ok(items);
      if (retries >= retryLimit) {
        return Result.err(
          EventStoreError.storage(`${operation} retry limit reached`, response),
        );
      }
      await sleep(Math.min(50 * 2 ** Number(retries), 1000));
      retries += BigInt(1);
    }
  } catch (cause) {
    return Result.err(EventStoreError.storage(`${operation} failed`, cause));
  }
}
