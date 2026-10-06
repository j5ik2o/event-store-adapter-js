import * as fs from "node:fs";
import * as path from "node:path";
import { CONFORMANCE_BACKENDS } from "./conformance-backend";
import { loadConformanceData } from "./conformance-data-loader";
import { verifyConformanceManifest } from "./conformance-manifest";
import {
  renderConformanceReportJson,
  summarizeConformanceReport,
} from "./conformance-report";
import { runConformance } from "./conformance-runner";

const root = path.resolve(__dirname, "../../../../../../../conformance");
const implementationVersion: string = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../../../../package.json"),
    "utf8",
  ),
).version;
const data = loadConformanceData(root);
const manifest = verifyConformanceManifest(root);

describe.each(CONFORMANCE_BACKENDS)("conformance (%s)", (backend) => {
  const report = runConformance({
    data,
    manifest,
    backend,
    implementationVersion,
    binding: undefined,
  });

  test("manifest matches the data files", () => {
    expect(manifest.ok).toBe(true);
  });

  test.each(report.results.map((r) => [r.caseId, r] as const))(
    "%s is neither passed nor failed and has a reason",
    (_id, result) => {
      expect(result.status).not.toBe("passed");
      expect(result.status).not.toBe("failed");
      expect(result.reason).not.toBe("");
    },
  );

  test("counts match the expected totals", () => {
    const expected =
      backend === "memory"
        ? { notApplicable: 12, unverified: 60 }
        : { notApplicable: 12, unverified: 104 };
    expect(report.counts["not-applicable"]).toBe(expected.notApplicable);
    expect(report.counts.unverified).toBe(expected.unverified);
    expect(report.counts.passed).toBe(0);
  });

  test("prints the summary and JSON report", () => {
    const summary = summarizeConformanceReport(report);
    const json = renderConformanceReportJson(report);
    console.log(summary);
    console.log(json);
    expect(summary).not.toBe("");
    expect(JSON.parse(json).backend).toBe(backend);
  });
});
