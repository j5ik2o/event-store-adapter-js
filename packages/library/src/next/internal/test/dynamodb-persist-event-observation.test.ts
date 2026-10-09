import {
  DynamoDBClient,
  GetItemCommand,
  ResourceNotFoundException,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBPersistEventObservation } from "./dynamodb-persist-event-observation";

function fixtureClient(failure = false) {
  const handle = jest.fn().mockResolvedValue({
    response: {
      statusCode: failure ? 400 : 200,
      headers: { "content-type": "application/x-amz-json-1.0" },
      body: Buffer.from(
        JSON.stringify(
          failure
            ? {
                __type: "ResourceNotFoundException",
                message: "fixture failure",
              }
            : {},
        ),
      ),
    },
  });
  return {
    handle,
    client: new DynamoDBClient({
      region: "us-west-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
      requestHandler: { handle },
    }),
  };
}
const commit = {
  TransactItems: [
    { Put: { TableName: "journal", Item: { aid: { S: "Order-1" } } } },
    { Put: { TableName: "head", Item: { aid: { S: "Order-1" } } } },
  ],
};

test("records a delegated SDK result, input and serialized wire body", async () => {
  const { client, handle } = fixtureClient();
  const gate = jest.fn().mockResolvedValue(undefined);
  const observation = new DynamoDBPersistEventObservation(client, gate);
  try {
    const output = await client.send(new TransactWriteItemsCommand(commit));
    const saved = observation.snapshot().observations[0];
    expect(saved.input).toEqual(commit);
    expect(JSON.parse(saved.wireBody as string)).toMatchObject({
      ...commit,
      ClientRequestToken: expect.any(String),
    });
    expect(saved.upstream).toEqual(output);
    expect(saved.error).toBeUndefined();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledTimes(1);
    observation.assertApplied();
  } finally {
    client.destroy();
  }
});

test("records and propagates the actual SDK exception", async () => {
  const { client } = fixtureClient(true);
  const observation = new DynamoDBPersistEventObservation(client);
  try {
    const cause = await client
      .send(new TransactWriteItemsCommand(commit))
      .catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(ResourceNotFoundException);
    expect(observation.snapshot().observations[0].error).toBe(cause);
    expect(observation.snapshot().observations[0].upstream).toBeUndefined();
  } finally {
    client.destroy();
  }
});

test("an unused commit fault remains recorded and fails the application check", async () => {
  const { client, handle } = fixtureClient();
  const observation = new DynamoDBPersistEventObservation(client);
  observation.failNext(new Error("planned failure"));
  try {
    await client.send(
      new GetItemCommand({ TableName: "head", Key: { aid: { S: "Order-1" } } }),
    );
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems: commit.TransactItems.slice(0, 1),
      }),
    );
    expect(handle).toHaveBeenCalledTimes(2);
    expect(observation.snapshot().unapplied).toEqual([0]);
    expect(() => observation.assertApplied()).toThrow("not applied");
  } finally {
    client.destroy();
  }
});

test("a replace-request fault fires once, before delegation, and later calls reach the SDK", async () => {
  const { client, handle } = fixtureClient();
  const observation = new DynamoDBPersistEventObservation(client);
  const cause = new Error("planned failure");
  observation.failNext(cause);
  try {
    await expect(
      client.send(new TransactWriteItemsCommand(commit)),
    ).rejects.toBe(cause);
    expect(handle).not.toHaveBeenCalled();
    expect(observation.snapshot().observations[0]).toMatchObject({
      error: cause,
      fault: 0,
    });
    expect(observation.snapshot().faults).toEqual([{ cause, applied: 1 }]);
    observation.assertApplied();
    await client.send(new TransactWriteItemsCommand(commit));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(observation.snapshot().observations[1].error).toBeUndefined();
  } finally {
    client.destroy();
  }
});

test.each([3, 4])(
  "applies faults and the send gate to a %i-action pair commit",
  async (count) => {
    const { client, handle } = fixtureClient();
    const gate = jest.fn().mockResolvedValue(undefined);
    const observation = new DynamoDBPersistEventObservation(client, gate);
    const cause = new Error("planned pair failure");
    const pair = {
      TransactItems: [
        ...commit.TransactItems,
        ...[0, 1].slice(0, count - 2).map((skey) => ({
          Put: {
            TableName: "snapshot",
            Item: { aid: { S: "Order-1" }, skey: { N: skey.toString() } },
          },
        })),
      ],
    };
    observation.failNext(cause);
    try {
      await expect(
        client.send(new TransactWriteItemsCommand(pair)),
      ).rejects.toBe(cause);
      expect(handle).not.toHaveBeenCalled();
      expect(gate).not.toHaveBeenCalled();
      observation.assertApplied();
      await client.send(new TransactWriteItemsCommand(pair));
      expect(gate).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(observation.snapshot().observations[1].input).toEqual(pair);
      expect(observation.snapshot().observations[1].upstream).toBeDefined();
    } finally {
      client.destroy();
    }
  },
);

test("configuration creation leaves a pair fault and gate untouched", async () => {
  const { client, handle } = fixtureClient();
  const gate = jest.fn().mockResolvedValue(undefined);
  const observation = new DynamoDBPersistEventObservation(client, gate);
  const cause = new Error("planned pair failure");
  observation.failNext(cause);
  try {
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems: ["journal", "snapshot", "head"].map((TableName) => ({
          Put: { TableName, Item: { aid: { S: "__config__" } } },
        })),
      }),
    );
    expect(handle).toHaveBeenCalledTimes(1);
    expect(gate).not.toHaveBeenCalled();
    expect(observation.snapshot().unapplied).toEqual([0]);
    await expect(
      client.send(new TransactWriteItemsCommand(commit)),
    ).rejects.toBe(cause);
    expect(handle).toHaveBeenCalledTimes(1);
    observation.assertApplied();
  } finally {
    client.destroy();
  }
});
