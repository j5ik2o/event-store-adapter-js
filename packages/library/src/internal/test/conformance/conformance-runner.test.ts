import * as path from "node:path";
import type { ConformanceBackend } from "./conformance-backend";
import { loadConformanceData } from "./conformance-data-loader";
import { verifyConformanceManifest } from "./conformance-manifest";
import { ConformanceMemoryBinding } from "./conformance-memory-binding";
import {
  renderConformanceReportJson,
  summarizeConformanceReport,
} from "./conformance-report";
import { runConformance } from "./conformance-runner";
import type { ConformanceStoreBinding } from "./conformance-store-binding";

const root = path.resolve(__dirname, "../../../../../../conformance");
const data = loadConformanceData(root);
const manifest = verifyConformanceManifest(root);

const run = async (
  backend: ConformanceBackend,
  binding: ConformanceStoreBinding<unknown, unknown> | undefined = undefined,
) =>
  runConformance({
    data,
    manifest,
    backend,
    implementationVersion: "0.0.0",
    implementationCommit: "abc123",
    binding,
  });

const dispose = jest.fn(async () => undefined);

const bindingFor = (
  backend: ConformanceBackend,
): ConformanceStoreBinding<unknown, unknown> => ({
  backend,
  createStore: jest.fn(async () => ({
    outcome: { kind: "ok" as const, value: {} as never },
    hooks: {},
    dispose,
  })),
  buildAggregateId: jest.fn(),
  buildEvent: jest.fn(),
  buildSnapshot: jest.fn(),
  validateSeqNrValue: jest.fn(),
});

describe("runConformance", () => {
  test.each([
    ["memory", 22, 67, 89],
    ["dynamodb", 22, 106, 128],
  ] as const)(
    "reports %s with %i not-applicable and %i unverified of %i",
    async (backend, notApplicable, unverified, total) => {
      const report = await run(backend);
      expect(report.counts["not-applicable"]).toBe(notApplicable);
      expect(report.counts.unverified).toBe(unverified);
      expect(report.counts.passed).toBe(0);
      expect(report.counts.failed).toBe(0);
      expect(report.counts["not-representable"]).toBe(0);
      expect(report.results).toHaveLength(total);
    },
  );

  test("gives every not-applicable result a non-empty reason and never passes", async () => {
    for (const r of (await run("dynamodb")).results) {
      expect(r.status).not.toBe("passed");
      expect(r.reason).not.toBe("");
    }
  });

  test("renders bigint values in a report as decimal strings", async () => {
    const base = await run("memory");
    const report = {
      ...base,
      results: [
        {
          ...base.results[0],
          expected: BigInt("9007199254740993"),
          actual: BigInt(-1),
        },
      ],
    };
    const parsed = JSON.parse(renderConformanceReportJson(report));
    expect(parsed.language).toBe("typescript");
    expect(parsed.backend).toBe("memory");
    expect(parsed.results[0].expected).toBe("9007199254740993");
    expect(parsed.results[0].actual).toBe("-1");
  });

  test("keeps SDK binary bytes, physical maps and nested error causes in JSON evidence", async () => {
    const base = await run("memory");
    const cloned = structuredClone({
      payload: Buffer.from([0, 128, 255]),
    });
    const cause = new Error("SDK failure", { cause: new Error("original") });
    const parsed = JSON.parse(
      renderConformanceReportJson({
        ...base,
        results: [
          {
            ...base.results[0],
            evidence: {
              ...cloned,
              history: new Map([["1", { seqNr: BigInt(1) }]]),
              received: Buffer.from([0, 128, 255]),
              cause,
            },
          },
        ],
      }),
    );
    expect(parsed.results[0].evidence).toMatchObject({
      payload: { base64: "AID/" },
      received: { base64: "AID/" },
      history: { "1": { seqNr: "1" } },
      cause: {
        name: "Error",
        message: "SDK failure",
        cause: { name: "Error", message: "original" },
      },
    });
  });

  test("executes all applicable cases through the public Memory binding", async () => {
    const report = await run("memory", new ConformanceMemoryBinding());
    expect(report.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(report.counts).toEqual({
      passed: 67,
      failed: 0,
      "not-applicable": 22,
      unverified: 0,
      "not-representable": 0,
    });
    expect(
      report.results.filter((r) => r.status === "passed").map((r) => r.caseId),
    ).toEqual(report.requiredCaseIds);
    expect(report.backendNotApplicable).toHaveLength(80);
    expect(report.backendNotApplicable.every((r) => r.reason.length > 0)).toBe(
      true,
    );
    expect(
      report.notApplicableReasons
        .map((entry) => entry.count)
        .sort((a, b) => a - b),
    ).toEqual([4, 8, 10]);
  });

  test("passes seed items and faults to createStore before creation", async () => {
    const binding = bindingFor("dynamodb");
    await run("dynamodb", binding);
    const calls = (binding.createStore as jest.Mock).mock.calls;
    const withFault = calls
      .map((c) => c[0])
      .find((c) => c.seedItems.length === 3 && c.faults.length === 1);
    expect(withFault.faults[0]).toMatchObject({
      operation: 0,
      phase: "configuration-read",
    });
  });

  test("rejects a binding for a different backend", async () => {
    await expect(run("memory", bindingFor("dynamodb"))).rejects.toThrow();
  });

  test("reports exclusions with reasons and the implementation commit", async () => {
    const report = await run("memory");
    expect(report.exclusions.map((e) => e.rule)).toEqual([
      "W-5",
      "R-7",
      "T-5",
      "T-6",
      "F-1",
      "F-2",
      "F-3",
      "F-4",
      "F-5",
      "DY-13",
      "DY-15",
      "SP-1",
      "DY-18",
      "MEM-1",
      "K-2",
      "MEM-4",
      "MEM-5",
      "MEM-7",
      "MEM-8",
      "MEM-9",
      "MEM-10",
      "MEM-11",
      "SQ-1",
      "SQ-3",
      "SQ-4",
      "SQ-5",
      "SQ-6",
      "SQ-8",
      "SQ-9",
      "SQ-10",
      "SQ-12",
      "SQ-14",
      "SQ-15",
      "SQ-16",
      "SQ-17",
      "SQ-18",
      "SPN-1",
      "SPN-3",
      "SPN-4",
      "SPN-5",
      "SPN-6",
      "SPN-9",
      "SPN-11",
      "SPN-13",
      "SPN-10",
      "SPN-12",
      "SPN-14",
      "BT-1",
      "BT-2",
      "BT-3",
      "BT-4",
      "BT-5",
      "BT-6",
      "BT-8",
      "BT-9",
      "BT-11",
      "BT-10",
      "BT-12",
      "BT-14",
    ]);
    expect(report.implementationCommit).toBe("abc123");
    const summary = summarizeConformanceReport(report);
    expect(summary).toContain("abc123");
    expect(summary).toContain("W-5");
    expect(summary).toContain("R-7");
    expect(summary).toContain("expected 1.3.0");
  });

  test("keeps per-backend status for the same case id", async () => {
    const synthetic = {
      id: "synthetic-ttl",
      rules: ["X-1"],
      source: "synthetic.json",
      format: "scenarios" as const,
      body: {
        backends: ["memory", "dynamodb"],
        requires: ["ttl"],
        steps: [],
      },
    };
    const input = { ...data, cases: [synthetic] };
    const [memory, dynamodb] = await Promise.all(
      (["memory", "dynamodb"] as const).map((backend) =>
        runConformance({
          data: input,
          manifest,
          backend,
          implementationVersion: "0.0.0",
          implementationCommit: null,
          binding: undefined,
        }),
      ),
    );
    expect(memory.results[0].status).toBe("not-applicable");
    expect(dynamodb.results[0].status).toBe("unverified");
  });

  test("summary mentions all five statuses", async () => {
    const summary = summarizeConformanceReport(await run("memory"));
    for (const s of [
      "passed",
      "failed",
      "not-applicable",
      "unverified",
      "not-representable",
    ]) {
      expect(summary).toContain(s);
    }
  });
});

test("a bigtable-only scenario is not selected for memory, so it is neither failed nor excluded as unprovided", async () => {
  const synthetic = {
    id: "bigtable-only",
    rules: ["BT-7"],
    source: "bigtable/journal-write.json",
    format: "scenarios" as const,
    body: { id: "bigtable-only", backends: ["bigtable"], steps: [] },
  };
  const report = await runConformance({
    data: { ...data, cases: [synthetic as never] },
    manifest,
    backend: "memory",
    implementationVersion: "0.0.0",
    implementationCommit: null,
    binding: bindingFor("memory"),
  });
  expect(report.results).toEqual([]);
  expect(report.counts.failed).toBe(0);
  expect(report.requiredCaseIds).toEqual([]);
});

test("a spanner-only scenario is not selected for memory but is required for spanner", async () => {
  const synthetic = {
    id: "spanner-only",
    rules: ["SPN-1"],
    source: "spanner/configuration.json",
    format: "scenarios" as const,
    body: { id: "spanner-only", backends: ["spanner"], steps: [] },
  };
  const memory = await runConformance({
    data: { ...data, cases: [synthetic as never] },
    manifest,
    backend: "memory",
    implementationVersion: "0.0.0",
    implementationCommit: null,
    binding: undefined,
  });
  const spanner = await runConformance({
    data: { ...data, cases: [synthetic as never] },
    manifest,
    backend: "spanner",
    implementationVersion: "0.0.0",
    implementationCommit: null,
    binding: undefined,
  });
  expect(memory.results).toEqual([]);
  expect(memory.backendNotApplicable).toHaveLength(1);
  expect(spanner.requiredCaseIds).toEqual(["spanner-only"]);
});
