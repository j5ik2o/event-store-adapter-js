import * as fs from "node:fs";
import * as path from "node:path";
import { ConformanceBigtableBinding } from "./conformance-bigtable-binding";
import { selectConformanceCases } from "./conformance-case-selector";
import { loadConformanceData } from "./conformance-data-loader";
import { implementationCommitOf } from "./conformance-implementation-commit";
import { verifyConformanceManifest } from "./conformance-manifest";
import type { ConformanceReport } from "./conformance-report";
import {
  renderConformanceReportJson,
  summarizeConformanceReport,
} from "./conformance-report";
import { runConformance } from "./conformance-runner";

const root = path.resolve(__dirname, "../../../../../../conformance");
const implementationVersion: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8"),
).version;
const data = loadConformanceData(root);
const manifest = verifyConformanceManifest(root);

describe("conformance (bigtable)", () => {
  let report: ConformanceReport;
  const binding = new ConformanceBigtableBinding();
  beforeAll(async () => {
    await binding.start();
    report = await runConformance({
      data,
      manifest,
      backend: "bigtable",
      implementationVersion,
      implementationCommit: implementationCommitOf(process.env),
      binding,
    });
    const directory =
      process.env.CONFORMANCE_REPORT_DIR ??
      path.resolve(__dirname, "../../../../coverage/conformance");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "bigtable.json"),
      renderConformanceReportJson(report),
    );
    console.log(summarizeConformanceReport(report));
  }, 1800000);
  afterAll(async () => {
    await binding.stop();
  }, 60000);

  test.each(
    selectConformanceCases(data.cases, "bigtable").map((c) => [c.id] as const),
  )("%s has a verified result or an explicit exclusion", (caseId) => {
    const result = report.results.find((r) => r.caseId === caseId);
    expect(result).toBeDefined();
    if (report.requiredCaseIds.includes(caseId)) {
      expect({
        status: result?.status,
        reason: result?.reason,
        operation: result?.failedOperation,
        expected: result?.expected,
        actual: result?.actual,
      }).toEqual({
        status: "passed",
        reason: "",
        operation: undefined,
        expected: undefined,
        actual: undefined,
      });
    } else {
      expect(result?.status).toBe("not-applicable");
      expect(result?.reason).not.toBe("");
    }
  });

  test("the cases that target bigtable (common, bigtable-specific, shared) are all required, except the four nanosecond cases", () => {
    const targeted = data.cases.filter((c) => {
      const backends = (c.body as { backends?: unknown }).backends;
      return Array.isArray(backends) && backends.includes("bigtable");
    });
    const nanoseconds = targeted.filter(
      (c) =>
        (c.body as { representation?: { time_precision?: unknown } })
          .representation?.time_precision === "nanoseconds",
    );
    expect(nanoseconds).toHaveLength(4);
    const applicable = targeted.filter((c) => !nanoseconds.includes(c));
    expect(report.requiredCaseIds).toEqual(
      expect.arrayContaining(applicable.map((c) => c.id)),
    );
    for (const c of nanoseconds) {
      expect(report.results.find((r) => r.caseId === c.id)).toMatchObject({
        status: "not-applicable",
        reason: "Date はミリ秒精度である",
      });
    }
  });

  test("every bigtable-specific case is required and passes", () => {
    const ids = data.cases
      .filter((c) => c.source.startsWith("bigtable/"))
      .map((c) => c.id);
    expect(ids).toHaveLength(12);
    expect(report.requiredCaseIds).toEqual(expect.arrayContaining(ids));
    for (const id of ids) {
      expect(report.results.find((r) => r.caseId === id)?.status).toBe(
        "passed",
      );
    }
  });

  test("the fnv1a64 reference values and the ten envelope cases run on bigtable", () => {
    const hash = data.cases.filter(
      (c) => (c.body as { operation?: unknown }).operation === "fnv1a64",
    );
    const envelope = data.cases.filter((c) =>
      /Bigtable/.test(String((c.body as { operation?: unknown }).operation)),
    );
    expect(hash).toHaveLength(4);
    expect(envelope).toHaveLength(10);
    for (const c of [...hash, ...envelope]) {
      expect(report.results.find((r) => r.caseId === c.id)?.status).toBe(
        "passed",
      );
    }
  });

  test("87 cases are required and all passed, with nothing failed, unverified or not representable", () => {
    expect(report.requiredCaseIds).toHaveLength(87);
    expect(
      report.results.filter((r) => r.status === "passed").map((r) => r.caseId),
    ).toEqual(report.requiredCaseIds);
    expect(report.counts.failed).toBe(0);
    expect(report.counts.unverified).toBe(0);
    expect(report.counts["not-representable"]).toBe(0);
  });

  test("the BT rules covered by the data are reported as passed", () => {
    for (const rule of ["BT-7", "BT-13", "BT-16", "BT-17", "E-1"]) {
      expect(report.ruleCounts[rule]?.passed).toBeGreaterThanOrEqual(1);
      expect(report.ruleCounts[rule]?.failed).toBe(0);
    }
  });

  test("no result is excluded because Bigtable is unprovided", () => {
    expect(
      report.results.filter((r) => r.reason.includes("提供しない")),
    ).toEqual([]);
  });
});
