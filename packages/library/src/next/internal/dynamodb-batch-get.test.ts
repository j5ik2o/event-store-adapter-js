import {
  type BatchGetItemCommand,
  type BatchGetItemCommandOutput,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { readDynamoDBBatch } from "./dynamodb-batch-get";

const client = new DynamoDBClient({
  region: "us-west-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const send = jest.spyOn(
  client as {
    send(command: BatchGetItemCommand): Promise<BatchGetItemCommandOutput>;
  },
  "send",
);
const request = {
  head: { Keys: [{ aid: { S: "Order-1" } }], ConsistentRead: true },
  snapshot: {
    Keys: [{ aid: { S: "Order-1" }, skey: { N: "0" } }],
    ConsistentRead: true,
  },
};
beforeEach(() => send.mockReset());
afterAll(() => {
  send.mockRestore();
  client.destroy();
});

test("empty unprocessed entries do not retry and empty responses remain absent", async () => {
  send.mockResolvedValueOnce({
    $metadata: {},
    Responses: { head: [] },
    UnprocessedKeys: { head: { Keys: [] }, snapshot: { Keys: [] } },
  });
  const sleep = jest.fn();

  const result = await readDynamoDBBatch(
    { client, retryLimit: 0 },
    request,
    "latest snapshot read",
    sleep,
  );

  expect(result).toEqual({ type: "ok", value: new Map() });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("a wait failure preserves its cause without publishing accumulated items", async () => {
  send.mockResolvedValueOnce({
    $metadata: {},
    Responses: { head: [{ aid: { S: "Order-1" } }] },
    UnprocessedKeys: { snapshot: { Keys: request.snapshot.Keys } },
  });
  const cause = new Error("wait failed");
  const sleep = jest.fn().mockRejectedValue(cause);

  const result = await readDynamoDBBatch(
    { client, retryLimit: 1 },
    request,
    "latest snapshot read",
    sleep,
  );

  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  if (result.type !== "err") throw new Error("expected failure");
  expect(result.error.cause).toBe(cause);
  expect(send).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledWith(50);
});
