import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCase } from "./conformance-case";
import type { CaseClassification } from "./conformance-case-classifier";
import { classifyCase } from "./conformance-case-classifier";
import type { ConformanceCaseResult } from "./conformance-case-result";
import { selectConformanceCases } from "./conformance-case-selector";
import { withCaseStore } from "./conformance-case-store-scope";
import type { ConformanceData } from "./conformance-data";
import type { ManifestVerification } from "./conformance-manifest";
import type { ConformanceReport } from "./conformance-report";
import { CONFORMANCE_STATUSES } from "./conformance-status";
import type { ConformanceStoreBinding } from "./conformance-store-binding";
import { storeCreationOf } from "./conformance-store-creation";

const UNVERIFIED_WITH_BINDING_REASON =
  "保存先の境界はあるが、場面のステップの実行がまだない";

const applyBinding = (
  classification: CaseClassification,
  binding: ConformanceStoreBinding<unknown, unknown> | undefined,
): CaseClassification =>
  binding !== undefined && classification.status === "unverified"
    ? { ...classification, reason: UNVERIFIED_WITH_BINDING_REASON }
    : classification;

const classifyWithBinding = async (
  c: ConformanceCase,
  backend: ConformanceBackend,
  binding: ConformanceStoreBinding<unknown, unknown> | undefined,
): Promise<CaseClassification> => {
  const classification = classifyCase(c, backend);
  if (
    binding === undefined ||
    classification.status !== "unverified" ||
    c.format !== "scenarios"
  ) {
    return applyBinding(classification, binding);
  }
  // この段階ではステップを実行しない。ストアの生成と後片付けの経路だけを通す。
  return withCaseStore(binding, storeCreationOf(c), async () =>
    applyBinding(classification, binding),
  );
};

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
  const results = await selectConformanceCases(
    input.data.cases,
    input.backend,
  ).reduce<Promise<readonly ConformanceCaseResult[]>>(async (previous, c) => {
    const done = await previous;
    const classification = await classifyWithBinding(
      c,
      input.backend,
      input.binding,
    );
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
  };
}
