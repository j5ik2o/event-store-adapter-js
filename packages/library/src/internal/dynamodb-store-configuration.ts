import { randomUUID } from "node:crypto";
import {
  type AttributeValue,
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../dynamodb-event-store-input";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { readDynamoDBBatch } from "./dynamodb-batch-get";

export type DynamoDBStoreConfiguration = Readonly<{
  storeId: string;
  layoutVersion: 1;
}>;

type ConfigurationInput = Readonly<
  Pick<DynamoDBEventStoreInput<unknown, unknown>, "client" | "tables"> & {
    retryLimit: number;
  }
>;
type ConfigurationKey = Readonly<{
  tableName: string;
  key: Record<string, AttributeValue>;
}>;

function configurationKeys(
  tables: ConfigurationInput["tables"],
): ConfigurationKey[] {
  return [
    {
      tableName: tables.journal,
      key: { aid: { S: "__config__" }, seq_nr: { N: "0" } },
    },
    {
      tableName: tables.snapshot,
      key: { aid: { S: "__config__" }, skey: { N: "0" } },
    },
    { tableName: tables.head, key: { aid: { S: "__config__" } } },
  ];
}

async function readConfiguration(
  input: ConfigurationInput,
  keys: ConfigurationKey[],
  sleep?: (ms: number) => Promise<void>,
): Promise<
  Result<(Record<string, AttributeValue> | undefined)[], EventStoreError>
> {
  const read = await readDynamoDBBatch(
    input,
    Object.fromEntries(
      keys.map(({ tableName, key }) => [
        tableName,
        { Keys: [key], ConsistentRead: true },
      ]),
    ),
    "configuration read",
    sleep,
  );
  if (read.type === "err") return read;
  return Result.ok(keys.map(({ tableName }) => read.value.get(tableName)));
}

function reconcileConfiguration(
  items: (Record<string, AttributeValue> | undefined)[],
): Result<DynamoDBStoreConfiguration | undefined, EventStoreError> {
  const present = items.filter((item) => item !== undefined);
  if (present.length === 0) return Result.ok(undefined);
  if (present.length !== items.length) {
    return Result.err(
      EventStoreError.configuration(
        "tables",
        "configuration items are partially present",
      ),
    );
  }
  const storeId = present[0].store_id?.S;
  if (
    typeof storeId !== "string" ||
    storeId.length === 0 ||
    present.some((item) => item.store_id?.S !== storeId)
  ) {
    return Result.err(
      EventStoreError.configuration(
        "store_id",
        "configuration store identifiers differ or are invalid",
      ),
    );
  }
  // DynamoDBのNは余分なゼロを除いた文字列。Numberへの変換では版1近傍が丸められる。
  if (present.some((item) => item.layout_version?.N !== "1")) {
    return Result.err(
      EventStoreError.configuration(
        "layout_version",
        "configuration layout version must be 1",
      ),
    );
  }
  return Result.ok(Object.freeze({ storeId, layoutVersion: 1 }));
}

/** 3表の設定だけを確定する。表作成・製品4操作は行わない。 */
export async function ensureDynamoDBStoreConfiguration(
  input: ConfigurationInput,
  sleep?: (ms: number) => Promise<void>,
): Promise<Result<DynamoDBStoreConfiguration, EventStoreError>> {
  const keys = configurationKeys(input.tables);
  const read = await readConfiguration(input, keys, sleep);
  if (read.type === "err") return read;
  const existing = reconcileConfiguration(read.value);
  if (existing.type === "err") return existing;
  if (existing.value !== undefined) return Result.ok(existing.value);

  const configuration = Object.freeze({
    storeId: randomUUID(),
    layoutVersion: 1 as const,
  });
  try {
    await input.client.send(
      new TransactWriteItemsCommand({
        TransactItems: keys.map(({ tableName, key }) => ({
          Put: {
            TableName: tableName,
            Item: {
              ...key,
              store_id: { S: configuration.storeId },
              layout_version: { N: "1" },
            },
            ConditionExpression: "attribute_not_exists(aid)",
          },
        })),
      }),
    );
    return Result.ok(configuration);
  } catch (cause) {
    const competingCreation =
      cause instanceof ConditionalCheckFailedException ||
      (cause instanceof TransactionCanceledException &&
        cause.CancellationReasons?.some(
          ({ Code }) =>
            Code === "ConditionalCheckFailed" || Code === "TransactionConflict",
        ));
    if (!competingCreation) {
      return Result.err(
        EventStoreError.storage("configuration creation failed", cause),
      );
    }
    // 初回の応答蓄積を共有せず、全3鍵を読み直す。作成は繰り返さない。
    const reread = await readConfiguration(input, keys, sleep);
    if (reread.type === "err") return reread;
    const reconciled = reconcileConfiguration(reread.value);
    if (reconciled.type === "err") return reconciled;
    if (reconciled.value === undefined) {
      return Result.err(
        EventStoreError.storage(
          "configuration missing after competing creation",
          cause,
        ),
      );
    }
    return Result.ok(reconciled.value);
  }
}
