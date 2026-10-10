import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCaseResult } from "./conformance-case-result";
import type { ConformanceExclusion } from "./conformance-exclusion";
import type { ManifestVerification } from "./conformance-manifest";
import type { ConformanceStatus } from "./conformance-status";
import { CONFORMANCE_STATUSES } from "./conformance-status";

export type ConformanceReport = {
  dataVersion: string;
  manifest: ManifestVerification;
  language: "typescript";
  implementationVersion: string;
  implementationCommit: string | null;
  backend: ConformanceBackend;
  results: readonly ConformanceCaseResult[];
  counts: Readonly<Record<ConformanceStatus, number>>;
  ruleCounts: Readonly<Record<string, Readonly<Record<string, number>>>>;
  exclusions: readonly ConformanceExclusion[];
  requiredCaseIds: readonly string[];
  backendNotApplicable: readonly ConformanceCaseResult[];
  notApplicableReasons: readonly {
    reason: string;
    caseIds: readonly string[];
    count: number;
  }[];
};

export function summarizeConformanceReport(r: ConformanceReport): string {
  const lines = CONFORMANCE_STATUSES.map(
    (status) => `  ${status}: ${r.counts[status]}`,
  );
  return [
    `conformance ${r.language} ${r.implementationVersion} (${r.backend}), data ${r.dataVersion}`,
    `commit: ${r.implementationCommit ?? "unknown"}`,
    `manifest: ${r.manifest.ok ? "ok" : "mismatch"} (${r.manifest.fileCount} files), version ${r.manifest.version ?? "unknown"} (expected ${r.manifest.expectedVersion})`,
    ...lines,
    `  backend not applicable: ${r.backendNotApplicable.length}`,
    ...r.notApplicableReasons.map(
      (entry) => `  not-applicable (${entry.count}): ${entry.reason}`,
    ),
    ...r.exclusions.map(
      (e) => `  excluded ${e.rule} (${e.status}): ${e.reason}`,
    ),
  ].join("\n");
}

export function renderConformanceReportJson(r: ConformanceReport): string {
  return JSON.stringify(
    r,
    (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Error)
        return {
          ...value,
          name: value.name,
          message: value.message,
          stack: value.stack,
          cause: value.cause,
        };
      if (value instanceof Map) return Object.fromEntries(value);
      if (value instanceof Uint8Array)
        return { base64: Buffer.from(value).toString("base64") };
      if (value?.type === "Buffer" && Array.isArray(value.data))
        return { base64: Buffer.from(value.data).toString("base64") };
      return value;
    },
    2,
  );
}
