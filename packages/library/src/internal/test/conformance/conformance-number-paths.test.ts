import { jsonAt } from "./conformance-json-lookup";
import { parseConformanceJson } from "./conformance-json-parser";
import { isSeqNrPath } from "./conformance-number-paths";

const parse = (text: string) =>
  parseConformanceJson(text, "case.json", (path) =>
    isSeqNrPath(undefined, path),
  );

describe("isSeqNrPath", () => {
  test("reads a fixture seq_nr as an exact bigint", () => {
    const v = parse(
      '{"fixtures":{"events":{"e1":{"seq_nr":9007199254740993}}}}',
    );
    expect(jsonAt(v, "fixtures", "events", "e1", "seq_nr")).toBe(
      BigInt("9007199254740993"),
    );
  });

  test("keeps numbers inside payload as number even when named seq_nr", () => {
    const v = parse(
      '{"fixtures":{"events":{"e1":{"seq_nr":1,"payload":{"seq_nr":5,"number":9007199254740992}}}}}',
    );
    const payload = ["fixtures", "events", "e1", "payload"] as const;
    expect(jsonAt(v, ...payload, "seq_nr")).toBe(5);
    expect(jsonAt(v, ...payload, "number")).toBe(9007199254740992);
  });

  test("reads history array elements as bigint", () => {
    const v = parse(
      '{"observe":{"history":{"active":[1,2],"marked":[],"absent":[3]}},"details":{"history_pages":[[30,29]]}}',
    );
    expect(jsonAt(v, "observe", "history", "active")).toEqual([
      BigInt(1),
      BigInt(2),
    ]);
    expect(jsonAt(v, "observe", "history", "absent")).toEqual([BigInt(3)]);
    expect(jsonAt(v, "details", "history_pages")).toEqual([
      [BigInt(30), BigInt(29)],
    ]);
  });

  test("keeps non seq_nr numbers and aggregate/binary_json contents as number", () => {
    const v = parse(
      '{"store":{"retention_count":2},"generators":[{"byte_length":420000}],"fixtures":{"snapshots":{"s1":{"seq_nr":1,"aggregate":{"seq_nr":3}}}},"binary_json":{"payload":{"total":1}}}',
    );
    const s1 = ["fixtures", "snapshots", "s1"] as const;
    expect(jsonAt(v, "store", "retention_count")).toBe(2);
    expect(jsonAt(v, "generators", 0, "byte_length")).toBe(420000);
    expect(jsonAt(v, ...s1, "aggregate", "seq_nr")).toBe(3);
    expect(jsonAt(v, "binary_json", "payload", "total")).toBe(1);
    expect(jsonAt(v, ...s1, "seq_nr")).toBe(BigInt(1));
  });

  test("treats values expect.value as bigint only for the values format", () => {
    const path = ["cases", 0, "expect", "value"];
    expect(isSeqNrPath("values", path)).toBe(true);
    expect(isSeqNrPath(undefined, path)).toBe(false);
  });
});
