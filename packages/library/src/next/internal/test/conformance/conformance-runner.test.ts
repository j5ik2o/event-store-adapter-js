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

const run = (
  backend: ConformanceBackend,
  binding: ConformanceStoreBinding<unknown, unknown> | undefined = undefined,
) =>
  runConformance({
    data,
    manifest,
    backend,
    implementationVersion: "0.0.0",
    binding,
  });

const bindingFor = (
  backend: ConformanceBackend,
): ConformanceStoreBinding<unknown, unknown> => ({
  backend,
  createStore: jest.fn(),
  buildEvent: jest.fn(),
  buildSnapshot: jest.fn(),
});

describe("runConformance", () => {
  test.each([
    ["memory", 12, 60, 72],
    ["dynamodb", 12, 104, 116],
  ] as const)(
    "reports %s with %i not-applicable and %i unverified of %i",
    (backend, notApplicable, unverified, total) => {
      const report = run(backend);
      expect(report.counts["not-applicable"]).toBe(notApplicable);
      expect(report.counts.unverified).toBe(unverified);
      expect(report.counts.passed).toBe(0);
      expect(report.counts.failed).toBe(0);
      expect(report.counts["not-representable"]).toBe(0);
      expect(report.results).toHaveLength(total);
    },
  );

  test("gives every not-applicable result a non-empty reason and never passes", () => {
    for (const r of run("dynamodb").results) {
      expect(r.status).not.toBe("passed");
      expect(r.reason).not.toBe("");
    }
  });

  test("renders bigint values in a report as decimal strings", () => {
    const base = run("memory");
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

  test("keeps counts with a binding and only changes the unverified reason", () => {
    const without = run("memory");
    const binding = bindingFor("memory");
    const withBinding = run("memory", binding);
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
    expect(binding.createStore).not.toHaveBeenCalled();
    expect(binding.buildEvent).not.toHaveBeenCalled();
    expect(binding.buildSnapshot).not.toHaveBeenCalled();
  });

  test("rejects a binding for a different backend", () => {
    expect(() => run("memory", bindingFor("dynamodb"))).toThrow();
  });

  test("summary mentions all five statuses", () => {
    const summary = summarizeConformanceReport(run("memory"));
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
