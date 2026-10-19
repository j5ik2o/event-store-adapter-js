import * as fs from "node:fs";
import * as path from "node:path";
import { SpannerEmulator } from "../spanner-emulator";
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
import { ConformanceSpannerBinding } from "./conformance-spanner-binding";

const root = path.resolve(__dirname, "../../../../../../conformance");
const implementationVersion: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8"),
).version;
const data = loadConformanceData(root);
const manifest = verifyConformanceManifest(root);

describe("conformance (spanner)", () => {
  let report: ConformanceReport;
  let emulator: SpannerEmulator | undefined;
  beforeAll(async () => {
    emulator = await SpannerEmulator.start();
    report = await runConformance({
      data,
      manifest,
      backend: "spanner",
      implementationVersion,
      implementationCommit: implementationCommitOf(process.env),
      binding: new ConformanceSpannerBinding(emulator),
    });
    const directory =
      process.env.CONFORMANCE_REPORT_DIR ??
      path.resolve(__dirname, "../../../../coverage/conformance");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "spanner.json"),
      renderConformanceReportJson(report),
    );
    console.log(summarizeConformanceReport(report));
  }, 900000);
  afterAll(async () => {
    await emulator?.stop();
  }, 60000);

  test.each(
    selectConformanceCases(data.cases, "spanner").map((c) => [c.id] as const),
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

  test("every case that targets spanner passes, except the nanosecond cases kept not-applicable as on the other backends", () => {
    const targeted = data.cases.filter((c) => {
      const backends = (c.body as { backends?: unknown }).backends;
      return Array.isArray(backends) && backends.includes("spanner");
    });
    // 共通 42 + spanner/ 14 + 共有 1
    expect(targeted).toHaveLength(57);
    const nanoseconds = targeted.filter(
      (c) =>
        (c.body as { representation?: { time_precision?: unknown } })
          .representation?.time_precision === "nanoseconds",
    );
    expect(nanoseconds.map((c) => c.id)).toHaveLength(4);
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

  test("the fnv1a64 reference values are required and passed on spanner", () => {
    const ids = data.cases
      .filter(
        (c) => (c.body as { operation?: unknown }).operation === "fnv1a64",
      )
      .map((c) => c.id);
    expect(ids).toHaveLength(4);
    expect(report.requiredCaseIds).toEqual(expect.arrayContaining(ids));
  });

  test("required results exactly cover the applicable cases with no failures", () => {
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

  test("the SPN rules are reported as passed", () => {
    for (const rule of ["SPN-2", "SPN-7", "SPN-8", "SPN-16", "SPN-17"]) {
      expect(report.ruleCounts[rule]?.passed).toBeGreaterThanOrEqual(1);
      expect(report.ruleCounts[rule]?.failed).toBe(0);
    }
  });

  test("sqlite and bigtable cases stay not-applicable with a reason", () => {
    const sqliteOrBigtable = report.results.filter(
      (r) => /^(SQ|BT)-/.test(r.rules[0] ?? "") && r.status !== "passed",
    );
    for (const r of sqliteOrBigtable) {
      expect(r.status).toBe("not-applicable");
      expect(r.reason).not.toBe("");
    }
  });
});
