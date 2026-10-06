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
    ...r.exclusions.map(
      (e) => `  excluded ${e.rule} (${e.status}): ${e.reason}`,
    ),
  ].join("\n");
}

export function renderConformanceReportJson(r: ConformanceReport): string {
  return JSON.stringify(
    r,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
