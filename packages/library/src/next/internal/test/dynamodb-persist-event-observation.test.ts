import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  ResourceNotFoundException,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBPersistEventObservation } from "./dynamodb-persist-event-observation";

function fixtureClient(failure = false, output: unknown = {}) {
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
            : output,
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

test("read faults select the operation, journal and page without touching GSI or other tables", async () => {
  const { client, handle } = fixtureClient();
  const observation = new DynamoDBPersistEventObservation(client);
  const cause = new Error("second page failed");
  const query = {
    TableName: "journal",
    KeyConditionExpression: "aid = :aid",
    ExpressionAttributeValues: { ":aid": { S: "Order-1" } },
  };
  observation.failReadEvents({
    operation: 2,
    table: "journal",
    page: 2,
    cause,
  });
  try {
    await client.send(new QueryCommand(query));
    observation.beginReadEvents("journal", 1);
    await client.send(new QueryCommand(query));
    observation.beginReadEvents("journal", 2);
    await client.send(new QueryCommand({ ...query, TableName: "snapshot" }));
    await client.send(new QueryCommand({ ...query, IndexName: "history" }));
    await client.send(new QueryCommand(query));
    expect(() => observation.assertApplied()).toThrow("not applied");
    await expect(client.send(new QueryCommand(query))).rejects.toBe(cause);
    expect(handle).toHaveBeenCalledTimes(5);
    const saved = observation.snapshot();
    expect(saved.queryFaults[0]).toMatchObject({
      applied: 1,
      injection: "replace-request",
    });
    expect(saved.observations[5]).toMatchObject({
      readEvents: { operation: 2, table: "journal", page: 2 },
      error: cause,
    });
    expect(saved.observations[5].upstream).toBeUndefined();
    observation.assertApplied();
    await client.send(new QueryCommand(query));
    expect(handle).toHaveBeenCalledTimes(6);
  } finally {
    client.destroy();
  }
});

test("records the original SDK response separately from a delivered replacement", async () => {
  const { client, handle } = fixtureClient();
  const observation = new DynamoDBPersistEventObservation(client);
  observation.beginReadEvents("journal", 3);
  observation.replaceReadEvents({
    operation: 3,
    table: "journal",
    page: 1,
    replace: (output) => ({ ...output, Items: [{ aid: { S: "Order-1" } }] }),
  });
  try {
    const returned = await client.send(
      new QueryCommand({ TableName: "journal" }),
    );
    expect(returned.Items).toEqual([{ aid: { S: "Order-1" } }]);
    const saved = observation.snapshot().observations[0];
    expect((saved.upstream as QueryCommandOutput).Items).toBeUndefined();
    expect(saved.returned).toEqual(returned);
    expect(handle).toHaveBeenCalledTimes(1);
    observation.assertApplied();
  } finally {
    client.destroy();
  }
});

test("an SDK failure leaves the selected response fault unapplied and preserves its cause", async () => {
  const { client, handle } = fixtureClient(true);
  const observation = new DynamoDBPersistEventObservation(client);
  const replace = jest.fn((output: QueryCommandOutput) => output);
  observation.beginReadEvents("journal", 1);
  observation.replaceReadEvents({
    operation: 1,
    table: "journal",
    page: 1,
    replace,
  });
  try {
    const cause = await client
      .send(new QueryCommand({ TableName: "journal" }))
      .catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(ResourceNotFoundException);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    const saved = observation.snapshot();
    expect(saved.observations[0].error).toBe(cause);
    expect(saved.observations[0].upstream).toBeUndefined();
    expect(saved.observations[0].returned).toBeUndefined();
    expect(saved.queryFaults[0].applied).toBe(0);
    expect(saved.queryUnapplied).toEqual([0]);
    expect(() => observation.assertApplied()).toThrow(
      "registered read-events fault was not applied",
    );
  } finally {
    client.destroy();
  }
});

test.each(["replace-request", "replace-response"] as const)(
  "%s copies the registered fault at application and preserves snapshot separation",
  async (injection) => {
    const { client, handle } = fixtureClient(false, { Items: [], Count: 0 });
    const observation = new DynamoDBPersistEventObservation(client);
    const cause = new Error("request blocked");
    const replace = jest.fn((output: QueryCommandOutput) => {
      expect(observation.snapshot().queryFaults[0].applied).toBe(1);
      return { ...output, Count: 7 };
    });
    observation.beginReadEvents("journal", 1);
    if (injection === "replace-request") {
      observation.failReadEvents({
        operation: 1,
        table: "journal",
        page: 1,
        cause,
      });
    } else {
      observation.replaceReadEvents({
        operation: 1,
        table: "journal",
        page: 1,
        replace,
      });
    }
    const registered = observation["queryFaults"][0];
    const before = observation.snapshot();
    try {
      if (injection === "replace-request") {
        await expect(
          client.send(new QueryCommand({ TableName: "journal" })),
        ).rejects.toBe(cause);
        expect(handle).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
        expect(observation.snapshot().observations[0].error).toBe(cause);
      } else {
        const returned = await client.send(
          new QueryCommand({ TableName: "journal" }),
        );
        expect(returned.Count).toBe(7);
        expect(handle).toHaveBeenCalledTimes(1);
        expect(replace).toHaveBeenCalledTimes(1);
      }
      expect(registered.applied).toBe(0);
      expect(before.queryFaults[0].applied).toBe(0);
      const applied = observation.snapshot();
      expect(applied.queryFaults[0].applied).toBe(1);
      expect(applied.queryUnapplied).toEqual([]);
      applied.queryFaults[0].applied = 99;
      expect(observation.snapshot().queryFaults[0].applied).toBe(1);
      const next = await client.send(
        new QueryCommand({ TableName: "journal" }),
      );
      expect(next.Count).toBe(0);
      expect(handle).toHaveBeenCalledTimes(
        injection === "replace-request" ? 1 : 2,
      );
      expect(replace).toHaveBeenCalledTimes(
        injection === "replace-request" ? 0 : 1,
      );
      expect(observation.snapshot().queryFaults[0].applied).toBe(1);
      observation.assertApplied();
    } finally {
      client.destroy();
    }
  },
);

test("application updates only the selected fault while another operation remains unapplied", async () => {
  const { client, handle } = fixtureClient();
  const observation = new DynamoDBPersistEventObservation(client);
  const cause = new Error("first operation blocked");
  const replace = jest.fn((output: QueryCommandOutput) => output);
  observation.replaceReadEvents({
    operation: 2,
    table: "journal",
    page: 1,
    replace,
  });
  observation.failReadEvents({
    operation: 1,
    table: "journal",
    page: 1,
    cause,
  });
  try {
    observation.beginReadEvents("journal", 1);
    await expect(
      client.send(new QueryCommand({ TableName: "journal" })),
    ).rejects.toBe(cause);
    expect(handle).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(
      observation.snapshot().queryFaults.map((fault) => fault.applied),
    ).toEqual([0, 1]);
    expect(observation.snapshot().queryUnapplied).toEqual([0]);
    expect(() => observation.assertApplied()).toThrow("not applied");
    observation.beginReadEvents("journal", 2);
    await client.send(new QueryCommand({ TableName: "journal" }));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(
      observation.snapshot().queryFaults.map((fault) => fault.applied),
    ).toEqual([1, 1]);
    expect(observation.snapshot().queryUnapplied).toEqual([]);
    observation.assertApplied();
  } finally {
    client.destroy();
  }
});

test("a replacement failure preserves the upstream response, applied count and its cause", async () => {
  const { client } = fixtureClient();
  const observation = new DynamoDBPersistEventObservation(client);
  const cause = new Error("replacement failed");
  observation.beginReadEvents("journal", 1);
  observation.replaceReadEvents({
    operation: 1,
    table: "journal",
    page: 1,
    replace() {
      expect(observation.snapshot().queryFaults[0].applied).toBe(1);
      throw cause;
    },
  });
  try {
    await expect(
      client.send(new QueryCommand({ TableName: "journal" })),
    ).rejects.toBe(cause);
    expect(observation.snapshot().observations[0].upstream).toBeDefined();
    expect(observation.snapshot().observations[0].error).toBe(cause);
    expect(observation.snapshot().queryFaults[0].applied).toBe(1);
    expect(observation.snapshot().queryUnapplied).toEqual([]);
    observation.assertApplied();
  } finally {
    client.destroy();
  }
});

test.each([undefined, { aid: { S: "Order-1" }, seq_nr: { N: "4" } }])(
  "truncates an oversized raw page to its actual prefix regardless of the raw LEK %p",
  async (lastEvaluatedKey) => {
    const items = Array.from({ length: 4 }, (_, n) => ({
      aid: { S: "Order-1" },
      seq_nr: { N: (n + 1).toString() },
      payload: { B: Buffer.alloc(320000, n + 1).toString("base64") },
    }));
    const { client, handle } = fixtureClient(false, {
      Items: items,
      Count: 4,
      ScannedCount: 4,
      LastEvaluatedKey: lastEvaluatedKey,
    });
    const observation = new DynamoDBPersistEventObservation(client);
    observation.beginReadEvents("journal", 1);
    try {
      const delivered = await client.send(
        new QueryCommand({ TableName: "journal" }),
      );
      const raw = observation.snapshot().observations[0]
        .upstream as QueryCommandOutput;
      expect(raw.Items).toHaveLength(4);
      expect(raw.Count).toBe(4);
      expect(raw.LastEvaluatedKey).toEqual(lastEvaluatedKey);
      expect(delivered.Items).toEqual(raw.Items?.slice(0, 3));
      expect(delivered).toMatchObject({
        Count: 3,
        ScannedCount: 3,
        LastEvaluatedKey: { aid: { S: "Order-1" }, seq_nr: { N: "3" } },
      });
      expect(observation.snapshot().observations[0].returned).toEqual(
        delivered,
      );
      expect(handle).toHaveBeenCalledTimes(1);
      observation.assertApplied();
    } finally {
      client.destroy();
    }
  },
);

test.each([1048575, 1048576, 1048577])(
  "uses UTF-8 attribute names and values and raw B bytes at %i bytes",
  async (totalBytes) => {
    const items = Array.from({ length: 4 }, (_, n) => ({
      aid: { S: "Order-界" },
      seq_nr: { N: (n + 1).toString() },
      界: {
        B: Buffer.alloc(n === 3 ? totalBytes - 786520 : 262144, n + 1).toString(
          "base64",
        ),
      },
    }));
    // 各項目: aid(3)+Order-界(9)+seq_nr(6)+N(1)+界(3)=22 bytes。
    const { client } = fixtureClient(false, { Items: items, Count: 4 });
    const observation = new DynamoDBPersistEventObservation(client);
    observation.beginReadEvents("journal", 1);
    try {
      const delivered = await client.send(
        new QueryCommand({ TableName: "journal" }),
      );
      const raw = observation.snapshot().observations[0]
        .upstream as QueryCommandOutput;
      if (totalBytes > 1048576) {
        expect(delivered.Items).toEqual(raw.Items?.slice(0, 3));
        expect(delivered.LastEvaluatedKey).toEqual({
          aid: { S: "Order-界" },
          seq_nr: { N: "3" },
        });
      } else expect(delivered).toEqual(raw);
    } finally {
      client.destroy();
    }
  },
);

test.each([
  {},
  { Items: [], LastEvaluatedKey: {} },
  { Items: [{ aid: { S: "Order-1" }, seq_nr: { N: "1" } }] },
  {
    Items: [{ aid: { S: "Order-1" }, seq_nr: { N: "1" } }],
    LastEvaluatedKey: { aid: { S: "Order-1" }, seq_nr: { N: "1" } },
  },
])(
  "preserves a non-oversized page, its LEK and terminal response %p",
  async (output) => {
    const { client, handle } = fixtureClient(false, output);
    const observation = new DynamoDBPersistEventObservation(client);
    observation.beginReadEvents("journal", 1);
    try {
      const delivered = await client.send(
        new QueryCommand({ TableName: "journal" }),
      );
      const saved = observation.snapshot().observations[0];
      expect(delivered).toEqual(saved.upstream);
      expect(saved.returned).toEqual(delivered);
      expect(handle).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
    }
  },
);

test("leaves oversized GSI, other-table and unmarked Query responses untouched", async () => {
  const items = Array.from({ length: 4 }, (_, n) => ({
    aid: { S: "Order-1" },
    seq_nr: { N: (n + 1).toString() },
    payload: { B: Buffer.alloc(320000).toString("base64") },
  }));
  const { client, handle } = fixtureClient(false, { Items: items });
  const observation = new DynamoDBPersistEventObservation(client);
  try {
    await client.send(new QueryCommand({ TableName: "journal" }));
    observation.beginReadEvents("journal", 1);
    await client.send(
      new QueryCommand({ TableName: "journal", IndexName: "history" }),
    );
    await client.send(new QueryCommand({ TableName: "snapshot" }));
    for (const saved of observation.snapshot().observations) {
      expect((saved.upstream as QueryCommandOutput).Items).toHaveLength(4);
      expect(saved.returned).toBeUndefined();
      expect(saved.readEvents).toBeUndefined();
    }
    const delivered = await client.send(
      new QueryCommand({ TableName: "journal" }),
    );
    expect(delivered.Items).toHaveLength(3);
    expect(observation.snapshot().observations[3].readEvents).toEqual({
      operation: 1,
      table: "journal",
      page: 1,
    });
    expect(handle).toHaveBeenCalledTimes(4);
  } finally {
    client.destroy();
  }
});

test("applies the existing response fault once after byte correction and records its final response", async () => {
  const items = Array.from({ length: 4 }, (_, n) => ({
    aid: { S: "Order-1" },
    seq_nr: { N: (n + 1).toString() },
    payload: { B: Buffer.alloc(320000).toString("base64") },
  }));
  const { client, handle } = fixtureClient(false, { Items: items });
  const observation = new DynamoDBPersistEventObservation(client);
  const replace = jest.fn((output: QueryCommandOutput) => ({
    ...output,
    Items: output.Items?.map((item) => ({ ...item, manifest: { S: "fault" } })),
  }));
  observation.beginReadEvents("journal", 1);
  observation.replaceReadEvents({
    operation: 1,
    table: "journal",
    page: 1,
    replace,
  });
  try {
    const first = await client.send(new QueryCommand({ TableName: "journal" }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0].Items).toHaveLength(3);
    expect(first.Items?.map((item) => item.manifest.S)).toEqual([
      "fault",
      "fault",
      "fault",
    ]);
    expect(observation.snapshot().observations[0].returned).toEqual(first);
    const second = await client.send(
      new QueryCommand({ TableName: "journal" }),
    );
    expect(second.Items?.every((item) => item.manifest === undefined)).toBe(
      true,
    );
    expect(replace).toHaveBeenCalledTimes(1);
    expect(observation.snapshot().queryFaults[0].applied).toBe(1);
    expect(observation.snapshot().queryUnapplied).toEqual([]);
    expect(handle).toHaveBeenCalledTimes(2);
    observation.assertApplied();
  } finally {
    client.destroy();
  }
});
