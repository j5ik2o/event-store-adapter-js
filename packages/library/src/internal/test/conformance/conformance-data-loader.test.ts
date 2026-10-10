import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConformanceData } from "./conformance-data-loader";
import { jsonAt } from "./conformance-json-lookup";

const root = path.resolve(__dirname, "../../../../../../conformance");

describe("loadConformanceData", () => {
  let copy: string | undefined;

  const makeCopy = (): string => {
    copy = fs.mkdtempSync(path.join(os.tmpdir(), "conformance-"));
    fs.cpSync(root, copy, { recursive: true });
    return copy;
  };

  const rewrite = (file: string, f: (text: string) => string): void => {
    const target = path.join(makeCopy(), file);
    fs.writeFileSync(target, f(fs.readFileSync(target, "utf8")));
  };

  afterEach(() => {
    if (copy !== undefined) {
      fs.rmSync(copy, { recursive: true, force: true });
      copy = undefined;
    }
  });

  test("loads 116 cases from the real data (30 values, 85 scenarios, 1 layout)", () => {
    const data = loadConformanceData(root);
    expect(data.version).toBe("1.0.0");
    expect(data.cases).toHaveLength(116);
    const count = (f: string) =>
      data.cases.filter((c) => c.format === f).length;
    expect(count("values")).toBe(30);
    expect(count("scenarios")).toBe(85);
    expect(count("layout")).toBe(1);
  });

  test("does not require format on schema files", () => {
    expect(() => loadConformanceData(root)).not.toThrow();
  });

  test("fails when a file format is rewritten", () => {
    rewrite("values/aid.json", (t) =>
      t.replace('"format": "values"', '"format": "scenarios"'),
    );
    expect(() => loadConformanceData(copy as string)).toThrow();
  });

  test("fails when a file version is rewritten", () => {
    rewrite("values/aid.json", (t) =>
      t.replace('"version": "1.0.0"', '"version": "2.0.0"'),
    );
    expect(() => loadConformanceData(copy as string)).toThrow();
  });

  test("fails when a duplicate key is inserted", () => {
    rewrite("values/aid.json", (t) =>
      t.replace(
        '"version": "1.0.0",',
        '"version": "1.0.0", "version": "1.0.0",',
      ),
    );
    expect(() => loadConformanceData(copy as string)).toThrow();
  });

  test("converts fixture occurred_at to epoch nanoseconds but leaves payload strings", () => {
    const dir = makeCopy();
    const extra = {
      format: "scenarios",
      version: "1.0.0",
      cases: [
        {
          id: "extra-time-case",
          rules: ["T-3"],
          description: "time conversion",
          backends: ["memory"],
          store: { retention_count: null, retention_mode: "delete" },
          steps: [],
          fixtures: {
            snapshots: {},
            events: {
              e1: {
                aggregate_id: { type_name: "Order", value: "1" },
                manifest: "",
                seq_nr: 1,
                occurred_at: "1969-12-31T23:59:59.999999999Z",
                payload: { occurred_at: "1970-01-01T00:00:00.123456789Z" },
              },
            },
          },
        },
      ],
    };
    fs.writeFileSync(
      path.join(dir, "scenarios", "extra.json"),
      JSON.stringify(extra),
    );
    const c = loadConformanceData(dir).cases.find(
      (x) => x.id === "extra-time-case",
    );
    expect(c).toBeDefined();
    const e1 = ["fixtures", "events", "e1"] as const;
    expect(jsonAt(c?.body, ...e1, "occurred_at")).toBe(BigInt(-1));
    expect(jsonAt(c?.body, ...e1, "payload", "occurred_at")).toBe(
      "1970-01-01T00:00:00.123456789Z",
    );
  });

  test("fails with a schema violation when a rule is not a string", () => {
    rewrite("values/aid.json", (t) =>
      t.replace(/"rules": \[\s*"/, '"rules": [1, "'),
    );
    // スキーマが rules の要素を文字列に限るので、ケースへの変換より前に検査で止まる
    expect(() => loadConformanceData(copy as string)).toThrow(
      /aid\.json: schema violation/,
    );
  });

  test("fails with a schema violation when backends is not an array", () => {
    rewrite("scenarios/core/retention-errors.json", (t) =>
      t.replace(/"backends": \[[^\]]*\]/, '"backends": "memory"'),
    );
    expect(() => loadConformanceData(copy as string)).toThrow(
      /retention-errors\.json: schema violation/,
    );
  });

  test("reports a schema violation before expanding generators", () => {
    const dir = makeCopy();
    fs.writeFileSync(
      path.join(dir, "scenarios", "extra.json"),
      JSON.stringify({
        format: "scenarios",
        version: "1.0.0",
        cases: [
          {
            id: "bad",
            rules: ["T-3"],
            generators: [{ target: "/x", character: "ab", byte_length: 2 }],
          },
        ],
      }),
    );
    expect(() => loadConformanceData(dir)).toThrow(/schema violation/);
  });

  test("fails on invalid UTF-8 instead of replacing it", () => {
    const dir = makeCopy();
    fs.writeFileSync(
      path.join(dir, "values", "aid.json"),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    );
    expect(() => loadConformanceData(dir)).toThrow("invalid UTF-8");
  });

  test("accepts a correctly encoded U+FFFD in a file", () => {
    rewrite("values/aid.json", (t) =>
      t.replace('"description": "', '"description": "\uFFFD'),
    );
    expect(() => loadConformanceData(copy as string)).not.toThrow();
  });

  test("loads the exclusions from coverage.json with reasons", () => {
    const { exclusions } = loadConformanceData(root);
    expect(exclusions.map((e) => [e.rule, e.status])).toEqual([
      ["W-5", "deleted"],
      ["R-7", "caller-obligation"],
    ]);
    expect(exclusions.every((e) => e.reason !== "")).toBe(true);
  });
});
