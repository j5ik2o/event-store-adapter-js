import { BigtableEventStore } from "../bigtable-event-store";
import { initializeBigtableStoreInternal } from "./bigtable-event-store";
import { BigtableEmulator } from "./test/bigtable-emulator";
import { eventOf, unwrap } from "./test/bigtable-fixture";

let emulator: BigtableEmulator;
beforeAll(async () => {
  emulator = await BigtableEmulator.start();
}, 300000);
afterAll(async () => {
  await emulator.stop();
}, 60000);

type RequestConfig = {
  client: string;
  method: string;
  gaxOpts?: { otherArgs?: { headers?: Record<string, string> } };
};

describe("access token (authentication hook)", () => {
  test("every data and admin request calls the token source once and carries the bearer header", async () => {
    const tables = await emulator.createTables();
    const spy = jest.spyOn(emulator.bigtable, "request");
    let tokens = 0;
    const accessToken = () => {
      tokens += 1;
      return `token-${tokens}`;
    };
    try {
      const input = {
        bigtable: emulator.bigtable,
        instanceId: emulator.instanceId,
        tables,
        accessToken,
      };
      unwrap(await initializeBigtableStoreInternal(input));
      const store = unwrap(await BigtableEventStore.create(input));
      unwrap(await store.persistEvent(eventOf("t1", 1)));
      unwrap(await store.persistEvent(eventOf("t1", 2)));
      const configs = spy.mock.calls.map((call) => call[0] as RequestConfig);
      const clients = new Set(configs.map((c) => c.client));
      expect(clients.has("BigtableTableAdminClient")).toBe(true);
      expect(clients.has("BigtableClient")).toBe(true);
      expect(configs.length).toBe(tokens);
      const seen = configs.map(
        (c) => c.gaxOpts?.otherArgs?.headers?.authorization,
      );
      expect(seen.every((h) => /^Bearer token-\d+$/.test(h ?? ""))).toBe(true);
      // トークンを使い回さない。
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      spy.mockRestore();
    }
  });

  test("a token source that fails sends nothing and returns a storage error without the token in the message", async () => {
    const tables = await emulator.createTables();
    const spy = jest.spyOn(emulator.bigtable, "request");
    try {
      const created = await BigtableEventStore.create({
        bigtable: emulator.bigtable,
        instanceId: emulator.instanceId,
        tables,
        accessToken: () => {
          throw new Error("secret-token-value");
        },
      });
      expect(created).toMatchObject({
        type: "err",
        error: { type: "storage-error" },
      });
      if (created.type === "err")
        expect(created.error.message).not.toContain("secret-token-value");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("a token that cannot be an ASCII header value is refused before sending", async () => {
    const tables = await emulator.createTables();
    const spy = jest.spyOn(emulator.bigtable, "request");
    try {
      for (const bad of ["tok\nen", "トークン", "tok\u007fen"]) {
        const created = await BigtableEventStore.create({
          bigtable: emulator.bigtable,
          instanceId: emulator.instanceId,
          tables,
          accessToken: async () => bad,
        });
        expect(created).toMatchObject({
          type: "err",
          error: { type: "storage-error" },
        });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("without an access token no authorization header is attached", async () => {
    const tables = await emulator.createTables();
    const spy = jest.spyOn(emulator.bigtable, "request");
    try {
      await BigtableEventStore.initialize({
        bigtable: emulator.bigtable,
        instanceId: emulator.instanceId,
        tables,
      });
      expect(spy).toHaveBeenCalled();
      for (const call of spy.mock.calls) {
        expect(
          (call[0] as RequestConfig).gaxOpts?.otherArgs?.headers?.authorization,
        ).toBeUndefined();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test("stream requests are sent with retries disabled so resumption stays in the library", async () => {
    const tables = await emulator.createTables();
    const spy = jest.spyOn(emulator.bigtable, "request");
    try {
      const input = {
        bigtable: emulator.bigtable,
        instanceId: emulator.instanceId,
        tables,
      };
      unwrap(await initializeBigtableStoreInternal(input));
      const store = unwrap(await BigtableEventStore.create(input));
      unwrap(await store.persistEvent(eventOf("t2", 1)));
      unwrap(await store.persistEvent(eventOf("t2", 2)));
      unwrap(
        await store.getEventsByIdSinceSeqNr(
          { typeName: "Order", value: "t2" },
          1,
        ),
      );
      const reads = spy.mock.calls
        .map(
          (call) =>
            call[0] as RequestConfig & { retryOpts?: { retries?: number } },
        )
        .filter((c) => c.method === "readRows");
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) expect(read.retryOpts?.retries).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
