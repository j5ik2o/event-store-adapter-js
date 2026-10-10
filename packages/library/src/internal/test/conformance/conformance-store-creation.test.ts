import * as path from "node:path";
import { aggregateIdInputOf } from "./conformance-aggregate-id-input";
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
