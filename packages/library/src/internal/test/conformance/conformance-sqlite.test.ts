import * as fs from "node:fs";
import * as path from "node:path";
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
import { ConformanceSqliteBinding } from "./conformance-sqlite-binding";

const root = path.resolve(__dirname, "../../../../../../conformance");
const implementationVersion: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8"),
).version;
const data = loadConformanceData(root);
const manifest = verifyConformanceManifest(root);

describe("conformance (sqlite)", () => {
  let report: ConformanceReport;
  beforeAll(async () => {
    report = await runConformance({
      data,
      manifest,
      backend: "sqlite",
      implementationVersion,
      implementationCommit: implementationCommitOf(process.env),
      binding: new ConformanceSqliteBinding(),
    });
    const directory =
      process.env.CONFORMANCE_REPORT_DIR ??
      path.resolve(__dirname, "../../../../coverage/conformance");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "sqlite.json"),
      renderConformanceReportJson(report),
    );
    console.log(summarizeConformanceReport(report));
  }, 600000);

  test.each(
    selectConformanceCases(data.cases, "sqlite").map((c) => [c.id] as const),
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

  test("every case that targets sqlite is required and passes, except the four nanosecond cases kept not-applicable as on the other backends", () => {
    const targeted = data.cases.filter((c) => {
      const backends = (c.body as { backends?: unknown }).backends;
      return Array.isArray(backends) && backends.includes("sqlite");
    });
    // 共通 42 + sqlite/ 7 + 共有 1
    expect(targeted).toHaveLength(50);
    const nanoseconds = targeted.filter(
      (c) =>
        (c.body as { representation?: { time_precision?: unknown } })
          .representation?.time_precision === "nanoseconds",
    );
    expect(nanoseconds.map((c) => c.id)).toHaveLength(4);
    const applicable = targeted.filter((c) => !nanoseconds.includes(c));
    expect(applicable).toHaveLength(46);
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

  test("the sqlite-specific and shared cases are required, not excluded for being unprovided", () => {
    const ids = data.cases
      .filter((c) => c.source.startsWith("sqlite/"))
      .map((c) => c.id);
    expect(ids).toHaveLength(7);
    expect(report.requiredCaseIds).toEqual(expect.arrayContaining(ids));
    expect(report.requiredCaseIds).toContain("sqlite-write-lock-busy");
    for (const id of ids) {
      expect(report.results.find((r) => r.caseId === id)?.status).toBe(
        "passed",
      );
    }
  });

  test("the fnv1a64 reference values stay not-applicable on sqlite, which does not hash", () => {
    const results = data.cases
      .filter(
        (c) => (c.body as { operation?: unknown }).operation === "fnv1a64",
      )
      .map((c) => report.results.find((r) => r.caseId === c.id));
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r?.status).toBe("not-applicable");
      expect(r?.reason).not.toBe("");
    }
  });

  test("68 cases are required and all passed, with nothing failed, unverified or not representable", () => {
    expect(report.requiredCaseIds).toHaveLength(68);
    expect(
      report.results.filter((r) => r.status === "passed").map((r) => r.caseId),
    ).toEqual(report.requiredCaseIds);
    expect(report.counts.failed).toBe(0);
    expect(report.counts.unverified).toBe(0);
    expect(report.counts["not-representable"]).toBe(0);
    expect(
      report.results
        .filter((r) => r.status === "not-applicable")
        .every((r) => r.reason.length > 0),
    ).toBe(true);
  });

  test("the SQ rules covered by the data are reported as passed", () => {
    for (const rule of ["SQ-2", "SQ-7", "SQ-11", "SQ-19", "SQ-20"]) {
      expect(report.ruleCounts[rule]?.passed).toBeGreaterThanOrEqual(1);
      expect(report.ruleCounts[rule]?.failed).toBe(0);
    }
  });

  test("only bigtable cases stay not-applicable for being unprovided", () => {
    const bigtable = report.results.filter(
      (r) => /^BT-/.test(r.rules[0] ?? "") && r.status !== "passed",
    );
    for (const r of bigtable) {
      expect(r.status).toBe("not-applicable");
      expect(r.reason).not.toBe("");
    }
    expect(
      report.results.filter(
        (r) =>
          r.status === "not-applicable" &&
          r.reason === "この言語は SQLite・Bigtable の保存先を提供しない",
      ),
    ).toEqual([]);
  });
});
