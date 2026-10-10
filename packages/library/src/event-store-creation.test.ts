import {
  BatchGetItemCommand,
  type BatchGetItemCommandOutput,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { EventStore, MemoryStorage, PayloadSerializer } from ".";
import * as memoryStorageRecords from "./internal/memory-storage-records";

function throwingAccess(
  target: object,
  field: string,
  read: () => never,
  access: "getter" | "Proxy",
): object {
  return access === "getter"
    ? Object.defineProperty(target, field, { get: read, configurable: true })
    : new Proxy(target, {
        get(object, key, receiver) {
          return key === field ? read() : Reflect.get(object, key, receiver);
        },
      });
}

const commonPaths = [
  "eventSerializer",
  "snapshotSerializer",
  "onRetentionFailure",
  "logger",
  "eventSerializer.serialize",
  "eventSerializer.deserialize",
  "snapshotSerializer.serialize",
  "snapshotSerializer.deserialize",
  "logger.trace",
  "logger.debug",
  "logger.info",
  "logger.warn",
  "logger.error",
];

describe.each(["getter", "Proxy"] as const)(
  "public creation with throwing %s access",
  (access) => {
    describe.each(["createMemory", "createDynamoDB"] as const)(
      "%s common settings",
      (entry) => {
        test.each(commonPaths)(
          "classifies %s access before calling serializers, storage or SDK",
          async (path) => {
            const cause = new Error(`cannot read ${path}`);
            const read = jest.fn(() => {
              throw cause;
            });
            const json = PayloadSerializer.json();
            const eventSerializer = {
              serialize: jest.fn(json.serialize),
              deserialize: jest.fn(json.deserialize),
            };
            const snapshotSerializer = {
              serialize: jest.fn(json.serialize),
              deserialize: jest.fn(json.deserialize),
            };
            const onRetentionFailure = jest.fn();
            const logger = {
              trace: jest.fn(),
              debug: jest.fn(),
              info: jest.fn(),
              warn: jest.fn(),
              error: jest.fn(),
            };
            const callables = [
              ...Object.values(eventSerializer),
              ...Object.values(snapshotSerializer),
              ...Object.values(logger),
              onRetentionFailure,
            ];
            const client = new DynamoDBClient({ region: "us-west-1" });
            const send = jest.spyOn(client, "send");
            const create = jest.spyOn(
              memoryStorageRecords,
              "createMemoryStorageRecords",
            );
            const commit = jest.spyOn(
              memoryStorageRecords,
              "commitMemoryStorageRecords",
            );
            const input: Record<string, unknown> = {
              client,
              tables: {
                journal: "journal",
                snapshot: "snapshot",
                head: "head",
              },
              snapshotAidIndexName: "snapshot-aid-index",
              eventSerializer,
              snapshotSerializer,
              onRetentionFailure,
              logger,
            };
            const [field, method] = path.split(".");
            const settings =
              method === undefined
                ? throwingAccess(input, field, read, access)
                : {
                    ...input,
                    [field]: throwingAccess(
                      input[field] as object,
                      method,
                      read,
                      access,
                    ),
                  };
            try {
              const result =
                entry === "createMemory"
                  ? EventStore.createMemory(settings as never)
                  : await EventStore.createDynamoDB(settings as never);

              expect(result).toMatchObject({
                type: "err",
                error: { type: "configuration-error", fieldName: field },
              });
              if (result.type !== "err") throw new Error("expected rejection");
              expect(result.error.cause).toBe(cause);
              expect(read).toHaveBeenCalledTimes(1);
              for (const callable of callables) {
                expect(callable).not.toHaveBeenCalled();
              }
              expect(create).not.toHaveBeenCalled();
              expect(commit).not.toHaveBeenCalled();
              expect(send).not.toHaveBeenCalled();
            } finally {
              create.mockRestore();
              commit.mockRestore();
              send.mockRestore();
              client.destroy();
            }
          },
        );
      },
    );

    test("classifies Memory storage acquisition before creating or saving records", () => {
      const cause = new Error("cannot read storage");
      const read = jest.fn(() => {
        throw cause;
      });
      const serialize = jest.fn();
      const deserialize = jest.fn();
      const input = throwingAccess(
        { eventSerializer: { serialize, deserialize } },
        "storage",
        read,
        access,
      );
      const create = jest.spyOn(
        memoryStorageRecords,
        "createMemoryStorageRecords",
      );
      const commit = jest.spyOn(
        memoryStorageRecords,
        "commitMemoryStorageRecords",
      );
      try {
        const result = EventStore.createMemory(input);

        expect(result).toMatchObject({
          type: "err",
          error: { type: "configuration-error", fieldName: "storage" },
        });
        if (result.type !== "err") throw new Error("expected rejection");
        expect(result.error.cause).toBe(cause);
        expect(read).toHaveBeenCalledTimes(1);
        expect(serialize).not.toHaveBeenCalled();
        expect(deserialize).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
        commit.mockRestore();
      }
    });

    test.each([
      "client",
      "tables",
      "snapshotAidIndexName",
      "retention",
      "retryLimit",
      "client.send",
      "tables.journal",
      "tables.snapshot",
      "tables.head",
      "retention.count",
      "retention.mode",
      "retention.mode.type",
      "retention.mode.graceSeconds",
    ])("classifies DynamoDB %s access before SDK IO", async (path) => {
      const cause = new Error(`cannot read ${path}`);
      const read = jest.fn(() => {
        throw cause;
      });
      const client = new DynamoDBClient({ region: "us-west-1" });
      const send = jest.spyOn(client, "send");
      const serialize = jest.fn();
      const deserialize = jest.fn();
      const mode = { type: "ttl", graceSeconds: 0 };
      const retention = { count: 1, mode };
      const input: Record<string, unknown> = {
        client,
        tables: { journal: "journal", snapshot: "snapshot", head: "head" },
        snapshotAidIndexName: "snapshot-aid-index",
        retention,
        eventSerializer: { serialize, deserialize },
      };
      const [field, nested, method] = path.split(".");
      let settings: object;
      if (nested === undefined) {
        settings = throwingAccess(input, field, read, access);
      } else if (method === undefined) {
        settings = {
          ...input,
          [field]: throwingAccess(input[field] as object, nested, read, access),
        };
      } else {
        settings = {
          ...input,
          retention: {
            count: 1,
            mode: throwingAccess(mode, method, read, access),
          },
        };
      }
      try {
        const result = await EventStore.createDynamoDB(settings as never);

        expect(result).toMatchObject({
          type: "err",
          error: {
            type: "configuration-error",
            fieldName: path === "client.send" ? "client" : path,
          },
        });
        if (result.type !== "err") throw new Error("expected rejection");
        expect(result.error.cause).toBe(cause);
        expect(read).toHaveBeenCalledTimes(1);
        expect(serialize).not.toHaveBeenCalled();
        expect(deserialize).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
        client.destroy();
      }
    });

    test.each([
      "retention",
      "changeFeed",
      "retention.count",
      "retention.mode",
      "retention.mode.type",
      "retention.mode.graceSeconds",
    ])("classifies MemoryStorage %s access before creating records", (path) => {
      const cause = new Error(`cannot read ${path}`);
      const read = jest.fn(() => {
        throw cause;
      });
      const mode = { type: "ttl", graceSeconds: 0 };
      const retention = { count: 1, mode };
      const input = { retention };
      const [field, nested, method] = path.split(".");
      let settings: object;
      if (nested === undefined) {
        settings = throwingAccess(input, field, read, access);
      } else if (method === undefined) {
        settings = {
          retention: throwingAccess(retention, nested, read, access),
        };
      } else {
        settings = {
          retention: {
            count: 1,
            mode: throwingAccess(mode, method, read, access),
          },
        };
      }
      const create = jest.spyOn(
        memoryStorageRecords,
        "createMemoryStorageRecords",
      );
      try {
        const result = MemoryStorage.create(settings);

        expect(result).toMatchObject({
          type: "err",
          error: { type: "configuration-error", fieldName: path },
        });
        if (result.type !== "err") throw new Error("expected rejection");
        expect(result.error.cause).toBe(cause);
        expect(read).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
      }
    });
  },
);

test("preserves common validation priority before reading Memory storage", () => {
  const storage = jest.fn(() => {
    throw new Error("storage must not be read");
  });
  expect(
    EventStore.createMemory({
      eventSerializer: null as never,
      get storage() {
        return storage();
      },
    }),
  ).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "eventSerializer" },
  });
  expect(storage).not.toHaveBeenCalled();
});

test("preserves setting acquisition order before common validation", () => {
  const cause = new Error("snapshot setting access failed");
  const result = EventStore.createMemory({
    eventSerializer: null as never,
    get snapshotSerializer(): never {
      throw cause;
    },
  });

  expect(result).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "snapshotSerializer" },
  });
  if (result.type !== "err") throw new Error("expected rejection");
  expect(result.error.cause).toBe(cause);
});

test("uses each Memory setting once and keeps the chosen storage", async () => {
  const created = MemoryStorage.create();
  if (created.type !== "ok") throw new Error("storage creation failed");
  const input = {
    storage: created.value,
    eventSerializer: PayloadSerializer.json(),
    snapshotSerializer: PayloadSerializer.json(),
    onRetentionFailure: jest.fn(),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
  const getters = Object.fromEntries(
    Object.entries(input).map(([field, value]) => [
      field,
      jest
        .fn()
        .mockReturnValueOnce(value)
        .mockImplementation(() => {
          throw new Error("setting read twice");
        }),
    ]),
  );
  const settings = Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(getters).map(([field, get]) => [field, { get }]),
    ),
  );
  const opened = EventStore.createMemory(settings);
  if (opened.type !== "ok") throw new Error("store creation failed");
  const event = {
    aggregateId: { typeName: "Order", value: "1" },
    seqNr: 1,
    occurredAt: new Date(0),
    manifest: "event",
    payload: { n: 1 },
  };

  expect(await opened.value.persistEvent(event)).toMatchObject({ type: "ok" });
  const shared = EventStore.createMemory({ storage: created.value });
  if (shared.type !== "ok") throw new Error("shared creation failed");
  expect(
    await shared.value.getEventsByIdSinceSeqNr(event.aggregateId, 1),
  ).toEqual({ type: "ok", value: [event] });
  for (const get of Object.values(getters))
    expect(get).toHaveBeenCalledTimes(1);
});

test("keeps DynamoDB SDK failures classified as storage errors", async () => {
  const cause = new Error("SDK request failed");
  const client = new DynamoDBClient({ region: "us-west-1" });
  const send = jest
    .spyOn(
      client as {
        send(command: BatchGetItemCommand): Promise<BatchGetItemCommandOutput>;
      },
      "send",
    )
    .mockRejectedValueOnce(cause);
  try {
    const result = await EventStore.createDynamoDB({
      client,
      tables: { journal: "journal", snapshot: "snapshot", head: "head" },
      snapshotAidIndexName: "snapshot-aid-index",
    });

    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    if (result.type !== "err") throw new Error("expected SDK failure");
    expect(result.error.cause).toBe(cause);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(BatchGetItemCommand);
  } finally {
    send.mockRestore();
    client.destroy();
  }
});

test("keeps DynamoDB setting validation before serializer method validation", async () => {
  const serialize = jest.fn(() => {
    throw new Error("serializer method must not be read");
  });
  const result = await EventStore.createDynamoDB({
    client: null as never,
    tables: { journal: "journal", snapshot: "snapshot", head: "head" },
    snapshotAidIndexName: "snapshot-aid-index",
    eventSerializer: {
      get serialize() {
        return serialize();
      },
      deserialize: jest.fn(),
    },
  });

  expect(result).toMatchObject({
    type: "err",
    error: { type: "configuration-error", fieldName: "client" },
  });
  expect(serialize).not.toHaveBeenCalled();
});

test("uses captured DynamoDB settings for the configuration request", async () => {
  const client = new DynamoDBClient({ region: "us-west-1" });
  const send = jest
    .spyOn(
      client as {
        send(command: BatchGetItemCommand): Promise<BatchGetItemCommandOutput>;
      },
      "send",
    )
    .mockResolvedValueOnce({
      $metadata: {},
      Responses: Object.fromEntries(
        ["journal", "snapshot", "head"].map((table) => [
          table,
          [
            {
              aid: { S: "__config__" },
              ...(table === "journal" ? { seq_nr: { N: "0" } } : {}),
              ...(table === "snapshot" ? { skey: { N: "0" } } : {}),
              store_id: { S: "fixed-store" },
              layout_version: { N: "1" },
            },
          ],
        ]),
      ),
    });
  const getters: jest.Mock[] = [];
  const tables = Object.defineProperties(
    {},
    Object.fromEntries(
      ["journal", "snapshot", "head"].map((field) => {
        const get = jest.fn().mockReturnValueOnce(field).mockReturnValue("");
        getters.push(get);
        return [field, { get }];
      }),
    ),
  );
  const type = jest.fn().mockReturnValueOnce("ttl").mockReturnValue("unknown");
  const graceSeconds = jest.fn().mockReturnValueOnce(0).mockReturnValue(-1);
  const count = jest.fn().mockReturnValueOnce(1).mockReturnValue(0);
  const mode = jest.fn().mockReturnValueOnce({
    get type() {
      return type();
    },
    get graceSeconds() {
      return graceSeconds();
    },
  });
  const retention = {
    get count() {
      return count();
    },
    get mode() {
      return mode();
    },
  };
  const input = {
    client,
    tables,
    snapshotAidIndexName: "snapshot-aid-index",
    retryLimit: 0,
    retention,
    eventSerializer: PayloadSerializer.json(),
    snapshotSerializer: PayloadSerializer.json(),
    onRetentionFailure: jest.fn(),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
  const settings = Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(input).map(([field, value]) => {
        const get = jest
          .fn()
          .mockReturnValueOnce(value)
          .mockImplementation(() => {
            throw new Error("setting read twice");
          });
        getters.push(get);
        return [field, { get }];
      }),
    ),
  );
  try {
    const result = await EventStore.createDynamoDB(settings as never);

    expect(result.type).toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
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
    for (const get of [...getters, type, graceSeconds, count, mode])
      expect(get).toHaveBeenCalledTimes(1);
  } finally {
    send.mockRestore();
    client.destroy();
  }
});

test("MemoryStorage captures delete retention without reading ttl settings", () => {
  const count = jest.fn().mockReturnValueOnce(1).mockReturnValue(0);
  const type = jest
    .fn()
    .mockReturnValueOnce("delete")
    .mockReturnValue("unknown");
  const graceSeconds = jest.fn(() => {
    throw new Error("delete mode has no graceSeconds");
  });
  const mode = jest.fn().mockReturnValueOnce({
    get type() {
      return type();
    },
    get graceSeconds() {
      return graceSeconds();
    },
  });
  const retention = jest.fn().mockReturnValueOnce({
    get count() {
      return count();
    },
    get mode() {
      return mode();
    },
  });
  const changeFeed = jest
    .fn()
    .mockReturnValueOnce(undefined)
    .mockReturnValue(true);

  const result = MemoryStorage.create({
    get retention() {
      return retention();
    },
    get changeFeed() {
      return changeFeed();
    },
  });

  expect(result.type).toBe("ok");
  for (const get of [count, type, mode, retention, changeFeed])
    expect(get).toHaveBeenCalledTimes(1);
  expect(graceSeconds).not.toHaveBeenCalled();
});
