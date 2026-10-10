import * as fs from "node:fs";
import * as path from "node:path";
import { DynamoDBLocal } from "../dynamodb-local";
import { CONFORMANCE_BACKENDS } from "./conformance-backend";
import { selectConformanceCases } from "./conformance-case-selector";
import { loadConformanceData } from "./conformance-data-loader";
import { ConformanceDynamoDBBinding } from "./conformance-dynamodb-binding";
import { implementationCommitOf } from "./conformance-implementation-commit";
import { verifyConformanceManifest } from "./conformance-manifest";
import { ConformanceMemoryBinding } from "./conformance-memory-binding";
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

describe.each(CONFORMANCE_BACKENDS)("conformance (%s)", (backend) => {
  let report: ConformanceReport;
  let local: DynamoDBLocal | undefined;
  beforeAll(async () => {
    if (backend === "dynamodb") local = await DynamoDBLocal.start();
    report = await runConformance({
      data,
      manifest,
      backend,
      implementationVersion,
      implementationCommit: implementationCommitOf(process.env),
      binding:
        local === undefined
          ? new ConformanceMemoryBinding()
          : new ConformanceDynamoDBBinding(local),
    });
    const directory =
      process.env.CONFORMANCE_REPORT_DIR ??
      path.resolve(__dirname, "../../../../coverage/conformance");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${backend}.json`),
      renderConformanceReportJson(report),
    );
    console.log(summarizeConformanceReport(report));
  }, 300000);
  afterAll(async () => {
    await local?.stop();
  }, 60000);

  test("manifest matches the distributed data files", () => {
    expect(manifest.ok).toBe(true);
  });

  test.each(
    selectConformanceCases(data.cases, backend).map((c) => [c.id] as const),
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
      expect(result?.evidence).toBeDefined();
    } else {
      expect(result?.status).toBe("not-applicable");
      expect(result?.reason).not.toBe("");
    }
  });

  test("required results exactly cover all applicable cases", () => {
    expect(report.requiredCaseIds).toHaveLength(
      backend === "memory" ? 60 : 104,
    );
    expect(
      report.results.filter((r) => r.status === "passed").map((r) => r.caseId),
    ).toEqual(report.requiredCaseIds);
    expect(report.counts).toEqual({
      passed: backend === "memory" ? 60 : 104,
      failed: 0,
      "not-applicable": 12,
      unverified: 0,
      "not-representable": 0,
    });
    expect(report.backendNotApplicable).toHaveLength(
      backend === "memory" ? 44 : 0,
    );
    expect(
      report.notApplicableReasons.map((entry) => entry.count).sort(),
    ).toEqual([4, 8]);
    expect(
      report.results
        .filter((r) => r.status === "not-applicable")
        .every((r) => r.reason.length > 0),
    ).toBe(true);
  });
});
