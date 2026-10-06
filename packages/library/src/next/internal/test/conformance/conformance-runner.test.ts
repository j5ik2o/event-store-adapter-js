import * as path from "node:path";
import type { ConformanceBackend } from "./conformance-backend";
import { loadConformanceData } from "./conformance-data-loader";
import { verifyConformanceManifest } from "./conformance-manifest";
import {
  renderConformanceReportJson,
  summarizeConformanceReport,
} from "./conformance-report";
import { runConformance } from "./conformance-runner";
import type { ConformanceStoreBinding } from "./conformance-store-binding";

const root = path.resolve(__dirname, "../../../../../../../conformance");
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
    kind: "ok" as const,
    value: { store: {} as never, hooks: {}, dispose },
  })),
  buildAggregateId: jest.fn(),
  buildEvent: jest.fn(),
  buildSnapshot: jest.fn(),
});

describe("runConformance", () => {
  test.each([
    ["memory", 12, 60, 72],
    ["dynamodb", 12, 104, 116],
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

  test("keeps counts with a binding and only changes the unverified reason", async () => {
    dispose.mockClear();
    const without = await run("memory");
    const binding = bindingFor("memory");
    const withBinding = await run("memory", binding);
    expect(withBinding.counts).toEqual(without.counts);
    expect(withBinding.counts.passed).toBe(0);
    expect(withBinding.counts.failed).toBe(0);
    withBinding.results.forEach((r, i) => {
      expect(r.status).toBe(without.results[i].status);
      expect(r.reason).not.toBe("");
      if (r.status === "unverified") {
        expect(r.reason).not.toBe(without.results[i].reason);
      } else {
        expect(r.reason).toBe(without.results[i].reason);
      }
    });
    const scenarioUnverified = withBinding.results.filter(
      (r) =>
        r.status === "unverified" &&
        data.cases.find((c) => c.id === r.caseId)?.format === "scenarios",
    ).length;
    expect(binding.createStore).toHaveBeenCalledTimes(scenarioUnverified);
    expect(dispose).toHaveBeenCalledTimes(scenarioUnverified);
    expect(binding.buildAggregateId).not.toHaveBeenCalled();
    expect(binding.buildEvent).not.toHaveBeenCalled();
    expect(binding.buildSnapshot).not.toHaveBeenCalled();
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
    expect(report.exclusions.map((e) => e.rule)).toEqual(["W-5", "R-7"]);
    expect(report.implementationCommit).toBe("abc123");
    const summary = summarizeConformanceReport(report);
    expect(summary).toContain("abc123");
    expect(summary).toContain("W-5");
    expect(summary).toContain("R-7");
    expect(summary).toContain("expected 1.0.0");
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
