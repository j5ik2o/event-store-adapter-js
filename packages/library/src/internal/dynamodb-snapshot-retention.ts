import {
  type AttributeValue,
  BatchWriteItemCommand,
  type BatchWriteItemCommandInput,
  ConditionalCheckFailedException,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import type { DynamoDBRetentionHooks } from "./dynamodb-retention-hooks";
import { dynamoDBStoredInteger } from "./dynamodb-stored-integer";
import type { validateSnapshotRetention } from "./snapshot-retention-validation";

type Settings = Readonly<
  Pick<
    DynamoDBEventStoreInput<unknown, unknown>,
    "client" | "tables" | "snapshotAidIndexName"
  > & {
    retryLimit: number;
    retention: NonNullable<
      Extract<
        ReturnType<typeof validateSnapshotRetention>,
        { type: "ok" }
      >["value"]
    >;
  }
>;

/** 履歴を書いた確定後だけ呼ばれ、保存先の取り残しを毎回選び直す。 */
export async function retainDynamoDBSnapshots(
  settings: Settings,
  aid: string,
  justWrittenSeqNr: number,
  hooks?: DynamoDBRetentionHooks,
): Promise<void> {
  const { client, tables, snapshotAidIndexName, retention } = settings;
  // 集合はこの呼出し内に閉じ、SDK応答や共有設定を変更しない。
  const seqNrs = new Set([justWrittenSeqNr]);
  let cursor: Record<string, AttributeValue> | undefined;
  do {
    const response = await client.send(
      new QueryCommand({
        TableName: tables.snapshot,
        IndexName: snapshotAidIndexName,
        KeyConditionExpression: "aid = :aid",
        ExpressionAttributeValues: { ":aid": { S: aid } },
        ScanIndexForward: false,
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
      }),
    );
    for (const item of response.Items ?? []) {
      const seqNr = dynamoDBStoredInteger(
        item.skey?.N,
        "history skey",
        BigInt(1),
        BigInt(Number.MAX_SAFE_INTEGER),
      );
      if (seqNr.type === "err") throw seqNr.error;
      seqNrs.add(Number(seqNr.value));
    }
    cursor = response.LastEvaluatedKey;
  } while (cursor !== undefined && Object.keys(cursor).length !== 0);

  const targets = [...seqNrs].sort((a, b) => b - a).slice(retention.count);
  if (retention.mode.type === "delete") {
    const sleep =
      hooks?.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const retryLimit = BigInt(settings.retryLimit);
    for (let offset = 0; offset < targets.length; offset += 25) {
      let requestItems: NonNullable<
        BatchWriteItemCommandInput["RequestItems"]
      > = {
        [tables.snapshot]: targets.slice(offset, offset + 25).map((seqNr) => ({
          DeleteRequest: {
            Key: { aid: { S: aid }, skey: { N: seqNr.toString() } },
          },
        })),
      };
      let retries = BigInt(0);
      while (true) {
        const response = await client.send(
          new BatchWriteItemCommand({ RequestItems: requestItems }),
        );
        requestItems = Object.fromEntries(
          Object.entries(response.UnprocessedItems ?? {}).filter(
            ([, pending]) => pending.length > 0,
          ),
        );
        if (Object.keys(requestItems).length === 0) break;
        if (retries >= retryLimit)
          throw new Error("snapshot retention delete retry limit reached", {
            cause: response,
          });
        await sleep(Math.min(50 * 2 ** Number(retries), 1000));
        retries += BigInt(1);
      }
    }
    return;
  }

  const clock = hooks?.clock ?? (() => Date.now() / 1000);
  for (const seqNr of targets) {
    const expires =
      BigInt(Math.ceil(clock())) + BigInt(retention.mode.graceSeconds);
    try {
      await client.send(
        new UpdateItemCommand({
          TableName: tables.snapshot,
          Key: { aid: { S: aid }, skey: { N: seqNr.toString() } },
          UpdateExpression: "SET #ttl = :expires REMOVE active_history_seq_nr",
          ConditionExpression: "attribute_exists(active_history_seq_nr)",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":expires": { N: expires.toString() } },
        }),
      );
    } catch (cause) {
      if (!(cause instanceof ConditionalCheckFailedException)) throw cause;
    }
  }
}
