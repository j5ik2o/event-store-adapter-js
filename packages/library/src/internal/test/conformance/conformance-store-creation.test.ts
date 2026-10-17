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
      storeCreationOf(caseWith({ store: { lock_wait_milliseconds: 100 } })),
    ).toThrow("unsupported store setting lock_wait_milliseconds");
  });

  test("rejects a seed entry this runner does not interpret", () => {
    expect(() =>
      storeCreationOf(caseWith({ seed: { configuration: {} } })),
    ).toThrow("unsupported seed entry configuration");
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
          },
          seed: { items: [] },
        }),
      ),
    ).not.toThrow();
  });
});
