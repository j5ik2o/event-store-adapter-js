import * as path from "node:path";
import { loadConformanceData } from "./conformance-data-loader";
import { jsonAt } from "./conformance-json-lookup";
import { parseOccurredAtEpochNanos } from "./conformance-time";

const root = path.resolve(__dirname, "../../../../../../../conformance");

describe("parseOccurredAtEpochNanos", () => {
  test("converts the instant before the epoch to -1 nanosecond", () => {
    expect(parseOccurredAtEpochNanos("1969-12-31T23:59:59.999999999Z")).toBe(
      BigInt(-1),
    );
  });

  test("matches epoch_nanoseconds for all validateOccurredAt cases", () => {
    const cases = loadConformanceData(root).cases.filter(
      (c) => jsonAt(c.body, "operation") === "validateOccurredAt",
    );
    expect(cases).toHaveLength(11);
    for (const c of cases) {
      const iso = jsonAt(c.body, "input", "iso8601");
      expect(typeof iso).toBe("string");
      expect(parseOccurredAtEpochNanos(iso as string)).toBe(
        jsonAt(c.body, "input", "epoch_nanoseconds"),
      );
    }
  });

  test("rejects a fraction that is not nine digits", () => {
    expect(() =>
      parseOccurredAtEpochNanos("1970-01-01T00:00:00.12345678Z"),
    ).toThrow();
  });

  test("rejects month 13", () => {
    expect(() =>
      parseOccurredAtEpochNanos("1970-13-01T00:00:00.000000000Z"),
    ).toThrow();
  });
});
