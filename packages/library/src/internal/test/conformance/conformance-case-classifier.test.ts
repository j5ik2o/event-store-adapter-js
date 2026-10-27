import type { ConformanceCase } from "./conformance-case";
import { classifyCase } from "./conformance-case-classifier";
import type { ConformanceJsonValue } from "./conformance-json-value";

const valuesCase = (body: {
  readonly [key: string]: ConformanceJsonValue;
}): ConformanceCase => ({
  id: "c",
  rules: ["T-1"],
  source: "values/x.json",
  format: "values",
  body: { id: "c", ...body },
});

describe("classifyCase", () => {
  test.each(["memory", "dynamodb"] as const)(
    "marks fnv1a64 as not-applicable with a reason on %s",
    (backend) => {
      const r = classifyCase(valuesCase({ operation: "fnv1a64" }), backend);
      expect(r.status).toBe("not-applicable");
      expect(r.reason).not.toBe("");
    },
  );

  test("marks fnv1a64 as not-applicable on sqlite, which does not use the hash", () => {
    const r = classifyCase(valuesCase({ operation: "fnv1a64" }), "sqlite");
    expect(r.status).toBe("not-applicable");
    expect(r.reason).not.toBe("");
  });

  test("marks nanosecond representation as not-applicable on sqlite because Date has millisecond precision", () => {
    const c: ConformanceCase = {
      ...scenarioCase(["sqlite"]),
      body: {
        id: "s",
        backends: ["sqlite"],
        representation: { time_precision: "nanoseconds" },
      },
    };
    expect(classifyCase(c, "sqlite")).toEqual({
      status: "not-applicable",
      reason: "Date はミリ秒精度である",
    });
  });

  test.each(["spanner", "bigtable"] as const)(
    "keeps fnv1a64 as unverified on %s, which uses the hash",
    (backend) => {
      expect(
        classifyCase(valuesCase({ operation: "fnv1a64" }), backend).status,
      ).toBe("unverified");
    },
  );

  test("marks nanosecond precision as not-applicable with a reason", () => {
    const r = classifyCase(
      valuesCase({ representation: { time_precision: "nanoseconds" } }),
      "dynamodb",
    );
    expect(r.status).toBe("not-applicable");
    expect(r.reason).not.toBe("");
  });

  test("marks requires ttl as not-applicable on memory only", () => {
    const c: ConformanceCase = {
      id: "t",
      rules: ["R-1"],
      source: "scenarios/x.json",
      format: "scenarios",
      body: {
        id: "t",
        requires: ["ttl"],
        backends: ["memory", "dynamodb"],
      },
    };
    expect(classifyCase(c, "memory").status).toBe("not-applicable");
    expect(classifyCase(c, "dynamodb").status).toBe("unverified");
  });

  test("marks a seq_nr not exactly representable as number as not-representable", () => {
    const r = classifyCase(
      valuesCase({
        operation: "validateSeqNr",
        input: { seq_nr: BigInt("9007199254740993") },
      }),
      "memory",
    );
    expect(r.status).toBe("not-representable");
  });

  test("keeps signed_seq_nr and 2^53 as unverified", () => {
    const signed = classifyCase(
      valuesCase({
        input: { seq_nr: BigInt(-1) },
        representation: { signed_seq_nr: true },
      }),
      "memory",
    );
    const boundary = classifyCase(
      valuesCase({ input: { seq_nr: BigInt("9007199254740992") } }),
      "memory",
    );
    expect(signed.status).toBe("unverified");
    expect(boundary.status).toBe("unverified");
  });
});

const scenarioCase = (
  backends: readonly string[],
  extra: { readonly [key: string]: ConformanceJsonValue } = {},
): ConformanceCase => ({
  id: "s",
  rules: ["SQ-7"],
  source: "sqlite/write-lock.json",
  format: "scenarios",
  body: { id: "s", backends: [...backends], ...extra },
});

describe("classifyCase for Bigtable", () => {
  test("no scenario is excluded because Bigtable is unprovided: a bigtable-only scenario is unverified on bigtable", () => {
    expect(
      classifyCase(
        scenarioCase(["bigtable"], { store: { retention_count: 1 } }),
        "bigtable",
      ).status,
    ).toBe("unverified");
  });

  test("does not treat a sqlite-only scenario as an unprovided backend any more", () => {
    expect(
      classifyCase(
        scenarioCase(["sqlite"], { store: { lock_wait_milliseconds: 100 } }),
        "sqlite",
      ).status,
    ).toBe("unverified");
  });

  test("does not treat a spanner-only scenario as an unprovided backend any more", () => {
    expect(classifyCase(scenarioCase(["spanner"]), "spanner").status).toBe(
      "unverified",
    );
  });

  test.each([
    "encodeBigtableEventEnvelope",
    "encodeBigtableSnapshotEnvelope",
    "decodeBigtableEnvelope",
  ])("runs the %s operation on bigtable", (operation) => {
    expect(classifyCase(valuesCase({ operation }), "bigtable").status).toBe(
      "unverified",
    );
  });

  test.each([
    ["memory", "encodeBigtableEventEnvelope"],
    ["dynamodb", "encodeBigtableSnapshotEnvelope"],
    ["sqlite", "decodeBigtableEnvelope"],
    ["spanner", "decodeBigtableEnvelope"],
  ] as const)(
    "marks the Bigtable envelope operation on %s as not-applicable with a reason that names the storage format",
    (backend, operation) => {
      const r = classifyCase(valuesCase({ operation }), backend);
      expect(r.status).toBe("not-applicable");
      expect(r.reason).not.toBe("");
      expect(r.reason).not.toContain("提供しない");
    },
  );

  test("does not mark an unknown values operation as not-applicable", () => {
    expect(
      classifyCase(valuesCase({ operation: "encodeUnknown" }), "memory").status,
    ).toBe("unverified");
  });

  test("keeps the nanosecond representation as not-applicable on bigtable, as on the other backends", () => {
    const r = classifyCase(
      valuesCase({ representation: { time_precision: "nanoseconds" } }),
      "bigtable",
    );
    expect(r.status).toBe("not-applicable");
  });
});
