import * as path from "node:path";
import { aggregateIdInputOf } from "./conformance-aggregate-id-input";
import type { ConformanceCase } from "./conformance-case";
import { loadConformanceData } from "./conformance-data-loader";
import { storeCreationOf } from "./conformance-store-creation";

const root = path.resolve(__dirname, "../../../../../../conformance");
const data = loadConformanceData(root);
const find = (id: string) => {
  const c = data.cases.find((x) => x.id === id);
  if (c === undefined) {
    throw new Error(`missing ${id}`);
  }
  return c;
};

describe("storeCreationOf", () => {
  test("passes config, seed items and faults before creation", () => {
    const creation = storeCreationOf(find("dynamodb-config-unprocessed-keys"));
    expect(creation.config).toEqual({
      retentionCount: null,
      retentionMode: "delete",
    });
    expect(creation.seedItems).toHaveLength(3);
    expect(creation.faults).toHaveLength(1);
    expect(creation.faults[0]).toMatchObject({
      operation: 0,
      phase: "configuration-read",
    });
  });
});

describe("storeCreationOf change_feed", () => {
  test("reads store.change_feed when it is true", () => {
    expect(
      storeCreationOf(find("memory-change-feed-unsupported")).config,
    ).toEqual({
      retentionCount: null,
      retentionMode: "delete",
      changeFeed: true,
    });
  });

  test("omits changeFeed when store.change_feed is absent", () => {
    expect(
      "changeFeed" in
        storeCreationOf(find("dynamodb-config-unprocessed-keys")).config,
    ).toBe(false);
  });
});

describe("aggregateIdInputOf", () => {
  test("keeps user_string", () => {
    expect(aggregateIdInputOf(find("aid-library-format"))).toEqual({
      typeName: "Order",
      value: "123",
      userString: "custom-display-value",
    });
  });

  test("leaves userString undefined when absent", () => {
    expect(
      aggregateIdInputOf(find("aid-hyphen-value")).userString,
    ).toBeUndefined();
  });

  test("rejects a case that is not buildAid", () => {
    expect(() =>
      aggregateIdInputOf(find("dynamodb-config-unprocessed-keys")),
    ).toThrow();
  });
});

describe("storeCreationOf unknown entries", () => {
  const caseWith = (body: Record<string, unknown>): ConformanceCase => ({
    id: "x",
    rules: ["MEM-1"],
    source: "unit.json",
    format: "scenarios",
    body: { id: "x", backends: ["memory"], ...body } as never,
  });

  test("rejects a store setting this runner does not interpret", () => {
    expect(() =>
      storeCreationOf(caseWith({ store: { unknown_store_setting: 100 } })),
    ).toThrow("unsupported store setting unknown_store_setting");
  });

  test("rejects a seed entry this runner does not interpret", () => {
    expect(() =>
      storeCreationOf(caseWith({ seed: { unknown_entry: {} } })),
    ).toThrow("unsupported seed entry unknown_entry");
  });

  test("accepts every store setting and seed entry used by the provided backends", () => {
    expect(() =>
      storeCreationOf(
        caseWith({
          store: {
            retention_count: 1,
            retention_mode: "ttl",
            ttl_grace_seconds: 5,
            layout_version: 1,
            retry_limit: 2,
            change_feed: true,
            transaction_retry_limit: 3,
            ttl_grace_days: 7,
          },
          seed: {
            items: [],
            configuration: {},
            row_deletion_policy_days: 7,
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe("storeCreationOf for spanner", () => {
  test("reads transaction_retry_limit", () => {
    expect(
      storeCreationOf(find("spanner-aborted-retry-within-limit")).config,
    ).toMatchObject({ transactionRetryLimit: 3 });
  });

  test("reads ttl_grace_days", () => {
    expect(
      storeCreationOf(find("spanner-seeded-ttl-grace-client-mismatch")).config,
    ).toMatchObject({ retentionMode: "ttl", ttlGraceDays: 6 });
  });

  test("reads seed.configuration and seed.row_deletion_policy_days without rejecting them", () => {
    const creation = storeCreationOf(
      find("spanner-seeded-ttl-configuration-match"),
    );
    expect(creation.seedConfiguration).toEqual({
      store_id: "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11",
      layout_version: 1,
      keep_snapshot_count: 1,
      retention_mode: "ttl",
      ttl_grace_days: 7,
      change_feed_enabled: false,
    });
    expect(creation.rowDeletionPolicyDays).toBe(7);
  });

  test("keeps a null row_deletion_policy_days as null", () => {
    expect(
      storeCreationOf(find("spanner-seeded-configuration-match"))
        .rowDeletionPolicyDays,
    ).toBeNull();
  });

  test("omits the spanner settings for a case that does not declare them", () => {
    const creation = storeCreationOf(find("dynamodb-config-unprocessed-keys"));
    expect("transactionRetryLimit" in creation.config).toBe(false);
    expect("ttlGraceDays" in creation.config).toBe(false);
    expect(creation.seedConfiguration).toBeUndefined();
    expect(creation.rowDeletionPolicyDays).toBeUndefined();
  });
});

describe("storeCreationOf lock_wait_milliseconds", () => {
  test("reads store.lock_wait_milliseconds into the config", () => {
    expect(storeCreationOf(find("sqlite-write-lock-busy")).config).toEqual({
      retentionCount: null,
      retentionMode: "delete",
      lockWaitMilliseconds: 100,
    });
  });

  test("omits lockWaitMilliseconds when the case does not set it", () => {
    expect(
      "lockWaitMilliseconds" in
        storeCreationOf(find("sqlite-seeded-configuration-match")).config,
    ).toBe(false);
  });

  test("passes the seeded configuration of a sqlite case before creation", () => {
    expect(
      storeCreationOf(find("sqlite-seeded-keep-count-mismatch"))
        .seedConfiguration,
    ).toMatchObject({ keep_snapshot_count: 2, layout_version: 1 });
  });
});

describe("storeCreationOf for bigtable", () => {
  test("reads store.envelope_limit_bytes", () => {
    expect(
      storeCreationOf(find("bigtable-envelope-limit-above-maximum")).config,
    ).toMatchObject({ envelopeLimitBytes: 8388609 });
  });

  test("omits envelopeLimitBytes when the case does not set it", () => {
    expect(
      "envelopeLimitBytes" in
        storeCreationOf(find("bigtable-ttl-unsupported")).config,
    ).toBe(false);
  });

  test("passes the journal and head seed configuration through", () => {
    const creation = storeCreationOf(
      find("bigtable-seeded-envelope-limit-mismatch"),
    );
    expect(creation.seedConfiguration).toMatchObject({
      journal: { envelope_limit_bytes: 2097152 },
      head: { store_id: expect.any(String) },
    });
  });

  test("still rejects a store setting nobody interprets", () => {
    const c: ConformanceCase = {
      ...find("bigtable-ttl-unsupported"),
      body: { id: "x", store: { unknown_setting: 1 } },
    };
    expect(() => storeCreationOf(c)).toThrow("unsupported store setting");
  });
});
