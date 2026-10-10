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
  test("marks fnv1a64 as not-applicable with a reason", () => {
    const r = classifyCase(valuesCase({ operation: "fnv1a64" }), "memory");
    expect(r.status).toBe("not-applicable");
    expect(r.reason).not.toBe("");
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
