import {
  BatchGetItemCommand,
  type BatchGetItemCommandOutput,
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { ensureDynamoDBStoreConfiguration } from "./dynamodb-store-configuration";

const client = new DynamoDBClient({
  region: "us-west-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
// sendのcallback overloadではなく、この試験が使うPromise overloadを選ぶ。
const send = jest.spyOn(
  client as {
    send(
      command: BatchGetItemCommand | TransactWriteItemsCommand,
    ): Promise<BatchGetItemCommandOutput | TransactWriteItemsCommandOutput>;
  },
  "send",
);
const input = {
  client,
  tables: { journal: "journal", snapshot: "snapshot", head: "head" },
  retryLimit: 5,
};
const complete = {
  $metadata: {},
  Responses: {
    journal: [
      {
        aid: { S: "__config__" },
        seq_nr: { N: "0" },
        store_id: { S: "winner" },
        layout_version: { N: "1" },
      },
    ],
    snapshot: [
      {
        aid: { S: "__config__" },
        skey: { N: "0" },
        store_id: { S: "winner" },
        layout_version: { N: "1" },
      },
    ],
    head: [
      {
        aid: { S: "__config__" },
        store_id: { S: "winner" },
        layout_version: { N: "1" },
      },
    ],
  },
};
const pending = {
  $metadata: {},
  UnprocessedKeys: { head: { Keys: [{ aid: { S: "__config__" } }] } },
};
const sleep = jest.fn<Promise<void>, [number]>();

beforeEach(() => {
  send.mockReset();
  sleep.mockReset().mockResolvedValue(undefined);
});
afterAll(() => {
  send.mockRestore();
  client.destroy();
});

test("reads the three configuration keys in one strongly consistent batch", async () => {
  send.mockResolvedValueOnce(complete);

  const result = await ensureDynamoDBStoreConfiguration(input, sleep);

  expect(result).toEqual({
    type: "ok",
    value: { storeId: "winner", layoutVersion: 1 },
  });
  expect(send).toHaveBeenCalledTimes(1);
  const command = send.mock.calls[0][0];
  expect(command).toBeInstanceOf(BatchGetItemCommand);
  expect(command.input).toEqual({
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
  });
});

test("accumulates responses and retries only pending keys with strong consistency", async () => {
  send
    .mockResolvedValueOnce({
      ...pending,
      Responses: {
        journal: complete.Responses.journal,
        snapshot: complete.Responses.snapshot,
      },
    })
    .mockResolvedValueOnce({
      $metadata: {},
      Responses: { head: complete.Responses.head },
      UnprocessedKeys: { head: { Keys: [] } },
    });

  const result = await ensureDynamoDBStoreConfiguration(input, sleep);

  expect(result).toMatchObject({ type: "ok", value: { storeId: "winner" } });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].input).toEqual({
    RequestItems: {
      head: { Keys: [{ aid: { S: "__config__" } }], ConsistentRead: true },
    },
  });
  expect(sleep.mock.calls).toEqual([[50]]);
});

test.each([
  [0, []],
  [1, [50]],
  [5, [50, 100, 200, 400, 800]],
  [7, [50, 100, 200, 400, 800, 1000, 1000]],
])(
  "retryLimit %i excludes the initial read and caps exponential delay",
  async (retryLimit, delays) => {
    send.mockResolvedValue(pending);

    const result = await ensureDynamoDBStoreConfiguration(
      { ...input, retryLimit },
      sleep,
    );

    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected retry exhaustion");
    expect(result.error.cause).toBe(pending);
    expect(send).toHaveBeenCalledTimes(retryLimit + 1);
    expect(
      send.mock.calls.every(
        ([command]) => command instanceof BatchGetItemCommand,
      ),
    ).toBe(true);
    expect(sleep.mock.calls).toEqual(delays.map((delay) => [delay]));
  },
);

test("default sleep waits before retrying", async () => {
  jest.useFakeTimers();
  try {
    send
      .mockResolvedValueOnce({
        ...pending,
        Responses: {
          journal: complete.Responses.journal,
          snapshot: complete.Responses.snapshot,
        },
      })
      .mockResolvedValueOnce({
        $metadata: {},
        Responses: { head: complete.Responses.head },
      });
    const result = ensureDynamoDBStoreConfiguration(input);
    await jest.advanceTimersByTimeAsync(49);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ type: "ok" });
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

test("unprocessed keys remain unresolved even with no returned items", async () => {
  send.mockResolvedValue(pending);

  const result = await ensureDynamoDBStoreConfiguration(
    { ...input, retryLimit: 0 },
    sleep,
  );

  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([Number.MAX_SAFE_INTEGER, 2 ** 53, Number.MAX_VALUE])(
  "accepts the existing validator's retryLimit range %p",
  async (retryLimit) => {
    send.mockResolvedValueOnce(complete);

    expect(
      await ensureDynamoDBStoreConfiguration({ ...input, retryLimit }, sleep),
    ).toMatchObject({ type: "ok", value: { storeId: "winner" } });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

test("creates only after all three keys have been processed and are absent", async () => {
  send
    .mockResolvedValueOnce(pending)
    .mockResolvedValueOnce({ $metadata: {} })
    .mockResolvedValueOnce({ $metadata: {} });

  const result = await ensureDynamoDBStoreConfiguration(input, sleep);

  expect(result).toMatchObject({ type: "ok", value: { layoutVersion: 1 } });
  expect(send.mock.calls[2][0]).toBeInstanceOf(TransactWriteItemsCommand);
  expect(send).toHaveBeenCalledTimes(3);
});

test("matches response items by table and the reserved key", async () => {
  send.mockResolvedValueOnce({
    ...complete,
    Responses: {
      ...complete.Responses,
      journal: [
        {
          ...complete.Responses.journal[0],
          seq_nr: { N: "1" },
          store_id: { S: "other" },
        },
        complete.Responses.journal[0],
      ],
    },
  });

  expect(await ensureDynamoDBStoreConfiguration(input, sleep)).toMatchObject({
    type: "ok",
    value: { storeId: "winner" },
  });
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([
  [{ store_id: { S: "" } }, "store_id"],
  [{ store_id: { N: "1" } }, "store_id"],
  [{ layout_version: { S: "1" } }, "layout_version"],
  [{ layout_version: { N: "2" } }, "layout_version"],
])(
  "rejects invalid configuration attributes %p",
  async (attributes, fieldName) => {
    send.mockResolvedValueOnce({
      ...complete,
      Responses: {
        ...complete.Responses,
        head: [
          {
            aid: { S: "__config__" },
            store_id: { S: "winner" },
            layout_version: { N: "1" },
            ...attributes,
          },
        ],
      },
    });

    expect(await ensureDynamoDBStoreConfiguration(input, sleep)).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName },
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

test("rejects partial configuration without creating missing items", async () => {
  send.mockResolvedValueOnce({
    $metadata: {},
    Responses: { journal: complete.Responses.journal },
  });

  expect(await ensureDynamoDBStoreConfiguration(input, sleep)).toMatchObject({
    type: "err",
    error: { type: "configuration-error" },
  });
  expect(send).toHaveBeenCalledTimes(1);
});

test.each(["journal", "snapshot", "head"])(
  "reconciles TransactionConflict in %s after rereading every table",
  async (table) => {
    const cause = new TransactionCanceledException({
      message: "competing creation",
      $metadata: {},
      CancellationReasons: Object.keys(input.tables).map((name) => ({
        Code: name === table ? "TransactionConflict" : "None",
      })),
    });
    send
      .mockResolvedValueOnce({ $metadata: {} })
      .mockRejectedValueOnce(cause)
      .mockResolvedValueOnce(complete);

    const result = await ensureDynamoDBStoreConfiguration(input, sleep);

    expect(result).toMatchObject({ type: "ok", value: { storeId: "winner" } });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0].input).toEqual(send.mock.calls[0][0].input);
  },
);

test("reconciles a direct conditional failure through a full reread", async () => {
  const cause = new ConditionalCheckFailedException({
    message: "condition failed",
    $metadata: {},
  });
  send
    .mockResolvedValueOnce({ $metadata: {} })
    .mockRejectedValueOnce(cause)
    .mockResolvedValueOnce(complete);

  expect(await ensureDynamoDBStoreConfiguration(input, sleep)).toMatchObject({
    type: "ok",
    value: { storeId: "winner" },
  });
  expect(send.mock.calls[2][0].input).toEqual(send.mock.calls[0][0].input);
});

test("a competing creation followed by all-absent reread stops without recreating", async () => {
  const cause = new TransactionCanceledException({
    message: "competing creation",
    $metadata: {},
    CancellationReasons: [{ Code: "TransactionConflict" }],
  });
  send
    .mockResolvedValueOnce({ $metadata: {} })
    .mockRejectedValueOnce(cause)
    .mockResolvedValueOnce({ $metadata: {} });

  const result = await ensureDynamoDBStoreConfiguration(input, sleep);

  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  if (result.type !== "err") throw new Error("expected missing configuration");
  expect(result.error.cause).toBe(cause);
  expect(
    send.mock.calls.filter(
      ([command]) => command instanceof TransactWriteItemsCommand,
    ),
  ).toHaveLength(1);
  expect(send.mock.calls[2][0].input).toEqual(send.mock.calls[0][0].input);
});

test("the conflict reread also retries unprocessed keys and propagates exhaustion", async () => {
  send
    .mockResolvedValueOnce({ $metadata: {} })
    .mockRejectedValueOnce(
      new TransactionCanceledException({
        message: "competing creation",
        $metadata: {},
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      }),
    )
    .mockResolvedValue(pending);

  const result = await ensureDynamoDBStoreConfiguration(
    { ...input, retryLimit: 1 },
    sleep,
  );

  expect(result).toMatchObject({
    type: "err",
    error: { type: "storage-error" },
  });
  if (result.type !== "err") throw new Error("expected exhaustion");
  expect(result.error.cause).toBe(pending);
  expect(send).toHaveBeenCalledTimes(4);
  expect(sleep.mock.calls).toEqual([[50]]);
});

test("a partial conflict reread is a configuration error", async () => {
  send
    .mockResolvedValueOnce({ $metadata: {} })
    .mockRejectedValueOnce(
      new TransactionCanceledException({
        message: "competing creation",
        $metadata: {},
        CancellationReasons: [{ Code: "TransactionConflict" }],
      }),
    )
    .mockResolvedValueOnce({
      $metadata: {},
      Responses: { head: complete.Responses.head },
    });

  expect(await ensureDynamoDBStoreConfiguration(input, sleep)).toMatchObject({
    type: "err",
    error: { type: "configuration-error" },
  });
  expect(send).toHaveBeenCalledTimes(3);
});

test.each(["initial read", "retry", "creation", "conflict reread"])(
  "preserves the SDK failure cause at %s",
  async (phase) => {
    const cause = new Error("SDK failure");
    if (phase === "retry") send.mockResolvedValueOnce(pending);
    if (phase === "creation" || phase === "conflict reread")
      send.mockResolvedValueOnce({ $metadata: {} });
    if (phase === "conflict reread")
      send.mockRejectedValueOnce(
        new TransactionCanceledException({
          message: "competing creation",
          $metadata: {},
          CancellationReasons: [{ Code: "TransactionConflict" }],
        }),
      );
    send.mockRejectedValueOnce(cause);

    const result = await ensureDynamoDBStoreConfiguration(input, sleep);

    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected SDK failure");
    expect(result.error.cause).toBe(cause);
  },
);

test.each([
  undefined,
  [{ Code: "ProvisionedThroughputExceeded" }],
  [{ Code: "None" }],
])(
  "other transaction cancellations %p remain storage failures",
  async (CancellationReasons) => {
    const cause = new TransactionCanceledException({
      message: "cancelled",
      $metadata: {},
      CancellationReasons,
    });
    send.mockResolvedValueOnce({ $metadata: {} }).mockRejectedValueOnce(cause);

    const result = await ensureDynamoDBStoreConfiguration(input, sleep);

    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected cancellation");
    expect(result.error.cause).toBe(cause);
    expect(send).toHaveBeenCalledTimes(2);
  },
);
