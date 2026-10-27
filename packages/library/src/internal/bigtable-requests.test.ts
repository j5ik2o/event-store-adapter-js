import { EventStoreError } from "../event-store-error";
import type { BigtableEventStoreHooks } from "./bigtable-event-store-hooks";
import type { BigtableRequestContext } from "./bigtable-request-context";
import { latestCell } from "./bigtable-request-parts";
import { BigtableTableRequests, getTableSchema } from "./bigtable-requests";
import { fakeBigtable, rowResponse } from "./test/bigtable-fake-client";

const contextOf = (
  bigtable: ReturnType<typeof fakeBigtable>,
  extra: Partial<BigtableRequestContext> = {},
): BigtableRequestContext => ({ bigtable, instanceId: "inst", ...extra });

describe("unary requests", () => {
  test("a failing request is a storage error that keeps the SDK failure as the cause", async () => {
    const failure = Object.assign(new Error("unavailable"), { code: 14 });
    const bigtable = fakeBigtable({ unary: () => ({ error: failure }) });
    const table = new BigtableTableRequests(contextOf(bigtable), "t");
    await expect(
      table.checkAndMutate(Buffer.from([1]), latestCell(), [], []),
    ).rejects.toMatchObject({
      type: "storage-error",
      cause: failure,
    });
  });

  test("an empty response means the predicate did not match", async () => {
    const bigtable = fakeBigtable({ unary: () => ({ response: undefined }) });
    const table = new BigtableTableRequests(contextOf(bigtable), "t");
    await expect(
      table.checkAndMutate(Buffer.from([1]), latestCell(), [], []),
    ).resolves.toBe(false);
  });

  test("a matched predicate is reported as true", async () => {
    const bigtable = fakeBigtable({
      unary: () => ({ response: { predicateMatched: true } }),
    });
    const table = new BigtableTableRequests(contextOf(bigtable), "t");
    await expect(
      table.checkAndMutate(Buffer.from([1]), latestCell(), [], []),
    ).resolves.toBe(true);
    expect(bigtable.calls).toHaveLength(1);
  });
});

describe("app profile and table name", () => {
  test.each([
    [undefined, ""],
    ["live", "live"],
  ])(
    "uses the client's app profile %s as %j in every request",
    async (profile, expected) => {
      const bigtable = fakeBigtable({
        ...(profile === undefined ? {} : { appProfileId: profile }),
        stream: () => [],
      });
      const table = new BigtableTableRequests(contextOf(bigtable), "journal-1");
      await table.readRow(Buffer.from([1]), latestCell());
      expect(bigtable.calls[0].reqOpts).toMatchObject({
        appProfileId: expected,
        tableName: "projects/fake-project/instances/inst/tables/journal-1",
      });
    },
  );
});

describe("request hooks and tokens", () => {
  test("beforeRequest sees the client, the method and the authorization when a token is set", async () => {
    const seen: unknown[] = [];
    const hooks: BigtableEventStoreHooks = {
      beforeRequest: (request) => {
        seen.push(request);
      },
    };
    const bigtable = fakeBigtable({ stream: () => [] });
    const withToken = new BigtableTableRequests(
      contextOf(bigtable, { hooks, accessToken: () => "tok" }),
      "t",
    );
    await withToken.readRow(Buffer.from([1]), latestCell());
    const without = new BigtableTableRequests(
      contextOf(bigtable, { hooks }),
      "t",
    );
    await without.readRow(Buffer.from([1]), latestCell());
    expect(seen).toEqual([
      {
        client: "BigtableClient",
        method: "readRows",
        authorization: "Bearer tok",
      },
      { client: "BigtableClient", method: "readRows" },
    ]);
  });

  test("a failing beforeRequest hook stops the request as a storage error", async () => {
    const bigtable = fakeBigtable({ stream: () => [] });
    const table = new BigtableTableRequests(
      contextOf(bigtable, {
        hooks: {
          beforeRequest: () => {
            throw new Error("hook failed");
          },
        },
      }),
      "t",
    );
    await expect(
      table.readRow(Buffer.from([1]), latestCell()),
    ).rejects.toMatchObject({
      type: "storage-error",
    });
    expect(bigtable.calls).toHaveLength(0);
  });

  test("an EventStoreError thrown by a hook is passed through unchanged", async () => {
    const error = EventStoreError.configuration("x", "from the hook");
    const bigtable = fakeBigtable({ stream: () => [] });
    const table = new BigtableTableRequests(
      contextOf(bigtable, {
        hooks: {
          beforeRequest: () => {
            throw error;
          },
        },
      }),
      "t",
    );
    await expect(table.readRow(Buffer.from([1]), latestCell())).rejects.toBe(
      error,
    );
  });

  test("a token source that returns a non-string is refused before sending", async () => {
    const bigtable = fakeBigtable({ stream: () => [] });
    const table = new BigtableTableRequests(
      contextOf(bigtable, { accessToken: () => 42 as never }),
      "t",
    );
    await expect(
      table.readRow(Buffer.from([1]), latestCell()),
    ).rejects.toMatchObject({
      type: "storage-error",
    });
    expect(bigtable.calls).toHaveLength(0);
  });
});

describe("range reads", () => {
  test("a stream that breaks after a completed row is resumed after that row's key", async () => {
    const first = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 1]);
    const second = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 2]);
    const bigtable = fakeBigtable({
      stream: (_config, attempt) =>
        attempt === 0
          ? [rowResponse(first, [["event", "envelope", "a"]]), new Error("cut")]
          : [rowResponse(second, [["event", "envelope", "b"]])],
    });
    const table = new BigtableTableRequests(contextOf(bigtable), "t");
    const rows = await table.readRange(
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([2]),
      latestCell(),
    );
    expect(rows.map((row) => Buffer.from(row.key).toString("hex"))).toEqual([
      first.toString("hex"),
      second.toString("hex"),
    ]);
    const ranges = bigtable.calls.map(
      (call) =>
        (call.reqOpts.rows as { rowRanges: Record<string, Buffer>[] })
          .rowRanges[0],
    );
    expect(ranges[0].startKeyClosed).toBeDefined();
    expect(ranges[0].startKeyOpen).toBeUndefined();
    expect(Buffer.from(ranges[1].startKeyOpen).equals(first)).toBe(true);
    expect(ranges[1].startKeyClosed).toBeUndefined();
    expect(bigtable.calls.every((c) => c.retryOpts?.retries === 0)).toBe(true);
  });
});

describe("single-row reads", () => {
  test("a stream that breaks right after the row completes returns the row with one request", async () => {
    const key = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 1]);
    const bigtable = fakeBigtable({
      stream: () => [
        rowResponse(key, [["event", "envelope", "a"]]),
        new Error("cut"),
      ],
    });
    const table = new BigtableTableRequests(contextOf(bigtable), "t");
    const row = await table.readRow(key, latestCell());
    expect(Buffer.from(row?.key ?? []).equals(key)).toBe(true);
    expect(bigtable.calls).toHaveLength(1);
    expect(bigtable.calls[0].reqOpts.rows).toEqual({ rowKeys: [key] });
  });

  test("a stream that breaks before the row completes is a storage error without a second request", async () => {
    const bigtable = fakeBigtable({
      stream: () => [new Error("unavailable")],
    });
    const table = new BigtableTableRequests(contextOf(bigtable), "t");
    await expect(
      table.readRow(Buffer.from([1]), latestCell()),
    ).rejects.toMatchObject({ type: "storage-error" });
    expect(bigtable.calls).toHaveLength(1);
  });
});

describe("table schema", () => {
  test("a missing table (NOT_FOUND) is undefined", async () => {
    const bigtable = fakeBigtable({
      unary: () => ({ error: Object.assign(new Error("nf"), { code: 5 }) }),
    });
    await expect(
      getTableSchema(contextOf(bigtable), "t"),
    ).resolves.toBeUndefined();
  });

  test("any other failure is a storage error", async () => {
    const bigtable = fakeBigtable({
      unary: () => ({ error: Object.assign(new Error("down"), { code: 14 }) }),
    });
    await expect(
      getTableSchema(contextOf(bigtable), "t"),
    ).rejects.toMatchObject({
      type: "storage-error",
    });
  });

  test("a table without column families has an empty schema", async () => {
    const bigtable = fakeBigtable({ unary: () => ({ response: {} }) });
    await expect(getTableSchema(contextOf(bigtable), "t")).resolves.toEqual({});
  });

  test("the families of the response are returned", async () => {
    const families = {
      event: { gcRule: { rule: "maxNumVersions", maxNumVersions: 1 } },
    };
    const bigtable = fakeBigtable({
      unary: () => ({ response: { columnFamilies: families } }),
    });
    await expect(getTableSchema(contextOf(bigtable), "t")).resolves.toEqual(
      families,
    );
    expect(bigtable.calls[0]).toMatchObject({
      client: "BigtableTableAdminClient",
      method: "getTable",
    });
  });
});
