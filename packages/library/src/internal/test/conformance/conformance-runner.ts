import type { ConformanceBackend } from "./conformance-backend";
import { classifyCase } from "./conformance-case-classifier";
import { executeConformanceCase } from "./conformance-case-executor";
import type { ConformanceCaseResult } from "./conformance-case-result";
import { selectConformanceCases } from "./conformance-case-selector";
import type { ConformanceData } from "./conformance-data";
import type { ManifestVerification } from "./conformance-manifest";
import type { ConformanceReport } from "./conformance-report";
import { CONFORMANCE_STATUSES } from "./conformance-status";
import type { ConformanceStoreBinding } from "./conformance-store-binding";

export async function runConformance(input: {
  data: ConformanceData;
  manifest: ManifestVerification;
  backend: ConformanceBackend;
  implementationVersion: string;
  implementationCommit: string | null;
  binding: ConformanceStoreBinding<unknown, unknown> | undefined;
}): Promise<ConformanceReport> {
  if (input.binding !== undefined && input.binding.backend !== input.backend) {
    throw new Error(
      `binding backend ${input.binding.backend} does not match ${input.backend}`,
    );
  }
  // ストアの生成は 1 ケースずつ順番に行う（並行には実行しない）。
  const selected = selectConformanceCases(input.data.cases, input.backend);
  const requiredCaseIds = selected
    .filter((c) => classifyCase(c, input.backend).status === "unverified")
    .map((c) => c.id);
  const backendNotApplicable = input.data.cases
    .filter((c) => !selected.includes(c))
    .map((c) => ({
      caseId: c.id,
      rules: c.rules,
      source: c.source,
      status: "not-applicable" as const,
      reason: `case does not target ${input.backend}`,
    }));
  const results = await selected.reduce<
    Promise<readonly ConformanceCaseResult[]>
  >(async (previous, c) => {
    const done = await previous;
    const classification = classifyCase(c, input.backend);
    if (input.binding !== undefined && classification.status === "unverified") {
      return [...done, await executeConformanceCase(c, input.binding)];
    }
    return [
      ...done,
      { caseId: c.id, rules: c.rules, source: c.source, ...classification },
    ];
  }, Promise.resolve([]));
  const counts = Object.fromEntries(
    CONFORMANCE_STATUSES.map((s) => [
      s,
      results.filter((r) => r.status === s).length,
    ]),
  ) as ConformanceReport["counts"];
  const rules = [...new Set(results.flatMap((r) => r.rules))];
  const notApplicableReasons = [
    ...new Set(
      results.filter((r) => r.status === "not-applicable").map((r) => r.reason),
    ),
  ].map((reason) => {
    const caseIds = results
      .filter((r) => r.status === "not-applicable" && r.reason === reason)
      .map((r) => r.caseId);
    return { reason, caseIds, count: caseIds.length };
  });
  const ruleCounts = Object.fromEntries(
    rules.map((rule) => [
      rule,
      Object.fromEntries(
        CONFORMANCE_STATUSES.map((s) => [
          s,
          results.filter((r) => r.status === s && r.rules.includes(rule))
            .length,
        ]),
      ),
    ]),
  );
  return {
    dataVersion: input.data.version,
    manifest: input.manifest,
    language: "typescript",
    implementationVersion: input.implementationVersion,
    implementationCommit: input.implementationCommit,
    backend: input.backend,
    results,
    counts,
    ruleCounts,
    exclusions: input.data.exclusions,
    requiredCaseIds,
    backendNotApplicable,
    notApplicableReasons,
  };
}
