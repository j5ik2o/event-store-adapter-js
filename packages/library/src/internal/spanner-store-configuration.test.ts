import {
  reconcileSpannerStoreConfiguration,
  type SpannerObservedConfiguration,
  verifySpannerStoreConfiguration,
} from "./spanner-store-configuration";
import { spannerTableNames } from "./spanner-table-names";

const key = ["hash_prefix", "aid"];
const col = (name: string, type: string) => ({ name, type });
const keyColumns = [col("hash_prefix", "BYTES(8)"), col("aid", "STRING(1024)")];
const observedOk = (): SpannerObservedConfiguration => ({
  dialect: "GOOGLE_STANDARD_SQL",
  columns: {
    journal: [
      ...keyColumns,
      col("seq_nr", "INT64"),
      col("occurred_at_ns", "INT64"),
      col("manifest", "STRING(MAX)"),
      col("payload", "BYTES(MAX)"),
    ],
    head: [
      ...keyColumns,
      col("type_name", "STRING(1024)"),
      col("seq_nr", "INT64"),
      col("event_occurred_at_ns", "INT64"),
      col("event_manifest", "STRING(MAX)"),
      col("event_payload", "BYTES(MAX)"),
    ],
    snapshotCurrent: [
      ...keyColumns,
      col("seq_nr", "INT64"),
      col("manifest", "STRING(MAX)"),
      col("payload", "BYTES(MAX)"),
    ],
    snapshotHistory: [
      ...keyColumns,
      col("seq_nr", "INT64"),
      col("manifest", "STRING(MAX)"),
      col("payload", "BYTES(MAX)"),
      col("expired_at", "TIMESTAMP"),
    ],
    config: [
      col("singleton", "INT64"),
      col("store_id", "STRING(36)"),
      col("layout_version", "INT64"),
      col("keep_snapshot_count", "INT64"),
      col("retention_mode", "STRING(8)"),
      col("ttl_grace_days", "INT64"),
      col("change_feed_enabled", "BOOL"),
    ],
  },
  primaryKeys: {
    journal: [...key, "seq_nr"],
    head: key,
    snapshotCurrent: key,
    snapshotHistory: [...key, "seq_nr"],
    config: ["singleton"],
  },
  rowDeletionPolicy: null,
  config: {
    store_id: "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11",
    layout_version: { value: "1" },
    keep_snapshot_count: null,
    retention_mode: "delete",
    ttl_grace_days: null,
    change_feed_enabled: false,
  },
});
const withConfig = (
  overrides: Record<string, unknown>,
  rest: Partial<SpannerObservedConfiguration> = {},
): SpannerObservedConfiguration => {
  const base = observedOk();
  return {
    ...base,
    ...rest,
    config: { ...base.config, ...overrides },
  };
};
const none = { retention: undefined };
const keep = (count: number) => ({
  retention: { count, mode: { type: "delete" as const } },
});
const ttl = (count: number, graceDays: number) => ({
  retention: { count, mode: { type: "ttl" as const, graceDays } },
});
const error = (
  observed: SpannerObservedConfiguration,
  settings: Parameters<typeof reconcileSpannerStoreConfiguration>[1],
) => {
  const result = reconcileSpannerStoreConfiguration(observed, settings);
  if (result.type === "ok") throw new Error("expected a configuration error");
  if (result.error.type !== "configuration-error")
    throw new Error(`expected a configuration error: ${result.error.type}`);
  return result.error;
};

describe("reconcileSpannerStoreConfiguration", () => {
  test("accepts a matching delete store and returns the store id", () => {
    expect(reconcileSpannerStoreConfiguration(observedOk(), none)).toEqual({
      type: "ok",
      value: { storeId: "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11" },
    });
  });

  test("accepts a matching delete store with a retention count", () => {
    expect(
      reconcileSpannerStoreConfiguration(
        withConfig({ keep_snapshot_count: { value: "2" } }),
        keep(2),
      ).type,
    ).toBe("ok");
  });

  test("accepts a matching ttl store whose three graceDays agree", () => {
    expect(
      reconcileSpannerStoreConfiguration(
        withConfig(
          {
            keep_snapshot_count: { value: "1" },
            retention_mode: "ttl",
            ttl_grace_days: { value: "7" },
          },
          { rowDeletionPolicy: "OLDER_THAN(expired_at, INTERVAL 7 DAY)" },
        ),
        ttl(1, 7),
      ).type,
    ).toBe("ok");
  });

  test("rejects a PostgreSQL dialect and an unknown dialect", () => {
    for (const dialect of ["POSTGRESQL", undefined])
      expect(error({ ...observedOk(), dialect }, none).fieldName).toBe(
        "database",
      );
  });

  test("rejects a missing or mistyped column", () => {
    const missing = observedOk();
    expect(
      error({ ...missing, columns: { ...missing.columns, head: [] } }, none)
        .fieldName,
    ).toBe("tablePrefix");
    expect(
      error(
        {
          ...missing,
          columns: {
            ...missing.columns,
            journal: missing.columns.journal.map((c) =>
              c.name === "seq_nr" ? col("seq_nr", "STRING(MAX)") : c,
            ),
          },
        },
        none,
      ).message,
    ).toContain("seq_nr");
  });

  test("rejects a different primary key order or length", () => {
    const base = observedOk();
    for (const journal of [
      ["aid", "hash_prefix", "seq_nr"],
      ["hash_prefix", "aid"],
    ])
      expect(
        error({ ...base, primaryKeys: { ...base.primaryKeys, journal } }, none)
          .message,
      ).toContain("primary key");
  });

  test("rejects a missing config row", () => {
    expect(
      error({ ...observedOk(), config: undefined }, none).message,
    ).toContain("config row");
  });

  test.each([
    ["store_id", { store_id: "ABC" }],
    ["store_id", { store_id: 1 }],
    ["layout_version", { layout_version: { value: "2" } }],
    ["layout_version", { layout_version: null }],
    ["keep_snapshot_count", { keep_snapshot_count: { value: "0" } }],
    ["retention_mode", { retention_mode: "archive" }],
    ["ttl_grace_days", { ttl_grace_days: { value: "0" } }],
    ["change_feed_enabled", { change_feed_enabled: true }],
    ["change_feed_enabled", { change_feed_enabled: null }],
  ])("rejects a recorded %s of %j", (field, overrides) => {
    expect(error(withConfig(overrides), none).message).toContain(field);
  });

  test("rejects a keep_snapshot_count that differs from the client", () => {
    expect(
      error(withConfig({ keep_snapshot_count: { value: "2" } }), keep(1))
        .fieldName,
    ).toBe("retention");
    expect(
      error(withConfig({ keep_snapshot_count: null }), keep(1)).fieldName,
    ).toBe("retention");
  });

  test("rejects a retention_mode that differs from the client", () => {
    expect(
      error(
        withConfig({ retention_mode: "ttl", ttl_grace_days: { value: "7" } }),
        none,
      ).fieldName,
    ).toBe("retention");
  });

  test("rejects a ttl_grace_days that is set for a delete store", () => {
    expect(
      error(withConfig({ ttl_grace_days: { value: "7" } }), none).message,
    ).toContain("ttl_grace_days");
  });

  test("rejects a row deletion policy on a delete store", () => {
    expect(
      error(
        {
          ...observedOk(),
          rowDeletionPolicy: "OLDER_THAN(expired_at, INTERVAL 7 DAY)",
        },
        none,
      ).fieldName,
    ).toBe("retention");
  });

  test.each([
    ["the recorded days", 8, "OLDER_THAN(expired_at, INTERVAL 7 DAY)", 7],
    ["the policy days", 7, "OLDER_THAN(expired_at, INTERVAL 8 DAY)", 7],
    ["the client days", 7, "OLDER_THAN(expired_at, INTERVAL 7 DAY)", 6],
    ["a missing policy", 7, null, 7],
    ["an unrelated policy", 7, "OLDER_THAN(other_column, INTERVAL 7 DAY)", 7],
  ])(
    "rejects a ttl store with %s that differ (SPN-16)",
    (_, recorded, policy, client) => {
      expect(
        error(
          withConfig(
            {
              keep_snapshot_count: { value: "1" },
              retention_mode: "ttl",
              ttl_grace_days: { value: String(recorded) },
            },
            { rowDeletionPolicy: policy },
          ),
          ttl(1, client),
        ).fieldName,
      ).toBe("retention");
    },
  );
});

describe("verifySpannerStoreConfiguration", () => {
  const tables = (() => {
    const names = spannerTableNames("esa");
    if (names.type === "err") throw new Error("names");
    return names.value;
  })();

  test("reads the dialect and observations in one strong snapshot and never writes", async () => {
    const run = jest.fn(async () => [[]]);
    const end = jest.fn();
    const getSnapshot = jest.fn(async () => [{ run, end }]);
    const result = await verifySpannerStoreConfiguration({
      database: {
        getDatabaseDialect: async () => "GOOGLE_STANDARD_SQL",
        getSnapshot,
      } as never,
      tables,
      retention: undefined,
    });
    expect(result).toMatchObject({
      type: "err",
      error: { type: "configuration-error" },
    });
    expect(getSnapshot).toHaveBeenCalledWith({ strong: true });
    expect(end).toHaveBeenCalledTimes(1);
    // config テーブルに列がないので、config 本体は読まない
    const sql = (run.mock.calls as unknown as { sql: string }[][]).map(
      ([call]) => call.sql,
    );
    expect(sql.every((statement) => statement.startsWith("SELECT"))).toBe(true);
    expect(sql.some((statement) => statement.includes("_config`"))).toBe(false);
  });

  test("an unknown dialect is a configuration error", async () => {
    const result = await verifySpannerStoreConfiguration({
      database: {
        getDatabaseDialect: async () => undefined,
        getSnapshot: async () => [{ run: async () => [[]], end: jest.fn() }],
      } as never,
      tables,
      retention: undefined,
    });
    expect(result).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "database" },
    });
  });

  test("a read failure is a storage error and the snapshot is ended", async () => {
    const end = jest.fn();
    const result = await verifySpannerStoreConfiguration({
      database: {
        getDatabaseDialect: async () => undefined,
        getSnapshot: async () => [
          {
            run: async () => {
              throw new Error("down");
            },
            end,
          },
        ],
      } as never,
      tables,
      retention: undefined,
    });
    expect(result).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
    expect(end).toHaveBeenCalledTimes(1);
  });
});
