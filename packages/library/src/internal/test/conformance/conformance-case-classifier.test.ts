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

  test("keeps fnv1a64 as unverified on spanner, which uses the hash", () => {
    expect(
      classifyCase(valuesCase({ operation: "fnv1a64" }), "spanner").status,
    ).toBe("unverified");
  });

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

describe("classifyCase for the backends this language does not provide", () => {
  const reason = "この言語は SQLite・Bigtable の保存先を提供しない";

  test.each(["memory", "dynamodb"] as const)(
    "marks a scenario targeting only sqlite as not-applicable on %s",
    (backend) => {
      const r = classifyCase(
        scenarioCase(["sqlite"], { store: { lock_wait_milliseconds: 100 } }),
        backend,
      );
      expect(r).toEqual({ status: "not-applicable", reason });
    },
  );

  test.each(["memory", "dynamodb", "spanner"] as const)(
    "marks a scenario targeting sqlite and bigtable as not-applicable on %s",
    (backend) => {
      expect(
        classifyCase(scenarioCase(["sqlite", "bigtable"]), backend),
      ).toEqual({ status: "not-applicable", reason });
    },
  );

  test("does not treat a spanner-only scenario as an unprovided backend any more", () => {
    expect(classifyCase(scenarioCase(["spanner"]), "spanner").status).toBe(
      "unverified",
    );
  });

  test("keeps a scenario that also targets a provided backend unverified", () => {
    const c = scenarioCase(["dynamodb", "sqlite"]);
    expect(classifyCase(c, "dynamodb").status).toBe("unverified");
  });

  test("marks Bigtable envelope operations as not-applicable with a reason", () => {
    for (const operation of [
      "encodeBigtableEventEnvelope",
      "encodeBigtableSnapshotEnvelope",
      "decodeBigtableEnvelope",
    ]) {
      expect(classifyCase(valuesCase({ operation }), "memory")).toEqual({
        status: "not-applicable",
        reason: "この言語は Bigtable の保存先を提供しない",
      });
    }
  });

  test("does not mark an unknown values operation as not-applicable", () => {
    expect(
      classifyCase(valuesCase({ operation: "encodeUnknown" }), "memory").status,
    ).toBe("unverified");
  });
});
