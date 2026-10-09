import {
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBConfigurationResponsePlan } from "./dynamodb-configuration-response-plan";

const request = {
  RequestItems: {
    journal: {
      Keys: [{ aid: { S: "__config__" }, seq_nr: { N: "0" } }],
      ConsistentRead: true,
    },
    snapshot: {
      Keys: [{ aid: { S: "__config__" }, skey: { N: "0" } }],
      ConsistentRead: true,
    },
    head: { Keys: [{ aid: { S: "__config__" } }], ConsistentRead: true },
  },
};
const upstream = {
  Responses: {
    journal: [
      {
        aid: { S: "__config__" },
        seq_nr: { N: "0" },
        store_id: { S: "upstream" },
        layout_version: { N: "1" },
      },
    ],
    snapshot: [
      {
        aid: { S: "__config__" },
        skey: { N: "0" },
        store_id: { S: "upstream" },
        layout_version: { N: "1" },
      },
    ],
    head: [
      {
        aid: { S: "__config__" },
        store_id: { S: "upstream" },
        layout_version: { N: "1" },
      },
    ],
  },
};

function fixtureClient(body: object, statusCode = 200) {
  return new DynamoDBClient({
    region: "us-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: {
      async handle() {
        return {
          response: {
            statusCode,
            headers: { "content-type": "application/x-amz-json-1.0" },
            body: Buffer.from(JSON.stringify(body)),
          },
        };
      },
    },
  });
}

test("moves actual requested keys out of the SDK upstream response without changing either", async () => {
  const client = fixtureClient(upstream);
  const plan = new DynamoDBConfigurationResponsePlan(client);
  plan.deferTables(["snapshot", "head"], 1);
  try {
    const output = await client.send(new BatchGetItemCommand(request));

    expect(output.Responses).toEqual({ journal: upstream.Responses.journal });
    expect(output.UnprocessedKeys).toEqual({
      snapshot: { Keys: request.RequestItems.snapshot.Keys },
      head: { Keys: request.RequestItems.head.Keys },
    });
    expect(plan.snapshot().observations[0].upstream).toMatchObject(upstream);
    expect(JSON.parse(plan.snapshot().observations[0].wireBody)).toEqual(
      request,
    );
    expect(plan.snapshot().plans).toEqual([
      { tables: ["snapshot", "head"], times: 1, applied: 1 },
    ]);
    plan.assertApplied();
  } finally {
    client.destroy();
  }
});

test("passes through the upstream response after the registered applications", async () => {
  const client = fixtureClient(upstream);
  const plan = new DynamoDBConfigurationResponsePlan(client);
  plan.deferTables(["head"], 1);
  try {
    await client.send(new BatchGetItemCommand(request));
    const output = await client.send(new BatchGetItemCommand(request));

    expect(output).toMatchObject(upstream);
    expect(plan.snapshot().plans[0].applied).toBe(1);
    plan.assertApplied();
  } finally {
    client.destroy();
  }
});

test("an unrelated table does not count as an application", async () => {
  const client = fixtureClient(upstream);
  const plan = new DynamoDBConfigurationResponsePlan(client);
  plan.deferTables(["different-table"], 1);
  try {
    const output = await client.send(new BatchGetItemCommand(request));

    expect(output).toMatchObject(upstream);
    expect(plan.snapshot().plans[0].applied).toBe(0);
    expect(() => plan.assertApplied()).toThrow("did not apply");
  } finally {
    client.destroy();
  }
});

test("an unrelated command does not count as an application", async () => {
  const client = fixtureClient({});
  const plan = new DynamoDBConfigurationResponsePlan(client);
  plan.deferTables(["head"], 1);
  try {
    const output = await client.send(
      new GetItemCommand({
        TableName: "head",
        Key: { aid: { S: "__config__" } },
      }),
    );

    expect(output.Item).toBeUndefined();
    expect(plan.snapshot().plans[0].applied).toBe(0);
    expect(() => plan.assertApplied()).toThrow("did not apply");
  } finally {
    client.destroy();
  }
});

test("partially consumed and never fired plans are distinguishable", async () => {
  const client = fixtureClient(upstream);
  const plan = new DynamoDBConfigurationResponsePlan(client);
  plan.deferTables(["head"], 2);
  plan.deferTables(["journal"], 1);
  try {
    await client.send(new BatchGetItemCommand(request));

    expect(plan.snapshot().plans.map(({ applied }) => applied)).toEqual([1, 0]);
    expect(() => plan.assertApplied()).toThrow("did not apply");
  } finally {
    client.destroy();
  }
});

test("records the SDK cause and calls the failure hook before propagating", async () => {
  const client = fixtureClient(
    { __type: "ResourceNotFoundException", message: "missing table" },
    400,
  );
  const onError = jest
    .fn<Promise<void>, [string, unknown]>()
    .mockResolvedValue(undefined);
  const beforeSend = jest
    .fn<Promise<void>, [string]>()
    .mockResolvedValue(undefined);
  const plan = new DynamoDBConfigurationResponsePlan(client, {
    beforeSend,
    onError,
  });
  try {
    let cause: unknown;
    try {
      await client.send(new BatchGetItemCommand(request));
    } catch (error) {
      cause = error;
    }

    expect(cause).toBeInstanceOf(ResourceNotFoundException);
    expect(plan.snapshot().observations[0].error).toBe(cause);
    expect(onError).toHaveBeenCalledWith("BatchGetItemCommand", cause);
    expect(beforeSend).toHaveBeenCalledWith("BatchGetItemCommand");
  } finally {
    client.destroy();
  }
});
