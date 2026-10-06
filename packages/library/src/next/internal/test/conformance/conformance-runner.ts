import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCase } from "./conformance-case";
import type { CaseClassification } from "./conformance-case-classifier";
import { classifyCase } from "./conformance-case-classifier";
import type { ConformanceCaseResult } from "./conformance-case-result";
import type { ConformanceData } from "./conformance-data";
import type { ManifestVerification } from "./conformance-manifest";
import type { ConformanceReport } from "./conformance-report";
import { CONFORMANCE_STATUSES } from "./conformance-status";
import type { ConformanceStoreBinding } from "./conformance-store-binding";

const UNVERIFIED_WITH_BINDING_REASON =
  "保存先の境界はあるが、場面のステップの実行がまだない";

const applyBinding = (
  classification: CaseClassification,
  binding: ConformanceStoreBinding<unknown, unknown> | undefined,
): CaseClassification =>
  binding !== undefined && classification.status === "unverified"
    ? { ...classification, reason: UNVERIFIED_WITH_BINDING_REASON }
    : classification;

const targetsBackend = (c: ConformanceCase, backend: ConformanceBackend) => {
  if (c.format === "values") {
    return true;
  }
  if (c.format === "layout") {
    return backend === "dynamodb";
  }
  const backends = (c.body as { readonly backends?: unknown }).backends;
  return Array.isArray(backends) && backends.includes(backend);
};

export function runConformance(input: {
  data: ConformanceData;
  manifest: ManifestVerification;
  backend: ConformanceBackend;
  implementationVersion: string;
  binding: ConformanceStoreBinding<unknown, unknown> | undefined;
}): ConformanceReport {
  if (input.binding !== undefined && input.binding.backend !== input.backend) {
    throw new Error(
      `binding backend ${input.binding.backend} does not match ${input.backend}`,
    );
  }
  const results: readonly ConformanceCaseResult[] = input.data.cases
    .filter((c) => targetsBackend(c, input.backend))
    .map((c) => ({
      caseId: c.id,
      rules: c.rules,
      source: c.source,
      ...applyBinding(classifyCase(c, input.backend), input.binding),
    }));
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
    backend: input.backend,
    results,
    counts,
    ruleCounts,
  };
}
