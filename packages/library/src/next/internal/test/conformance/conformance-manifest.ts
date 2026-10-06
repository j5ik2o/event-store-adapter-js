import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { listConformanceFiles } from "./conformance-file-lister";
import { parseConformanceJson } from "./conformance-json-parser";
import { readConformanceText } from "./conformance-text-reader";

const EXPECTED_VERSION = "1.0.0";

export type ManifestVerification = {
  ok: boolean;
  version: string | undefined;
  expectedVersion: string;
  versionMatches: boolean;
  fileCount: number;
  mismatches: readonly string[];
};

type ManifestEntry = { path: string; sha256: string };

const sha256Of = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const isEntry = (v: unknown): v is ManifestEntry =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { path?: unknown }).path === "string" &&
  typeof (v as { sha256?: unknown }).sha256 === "string";

export function verifyConformanceManifest(root: string): ManifestVerification {
  const actual = listConformanceFiles(root).filter(
    (f) => f !== "manifest.json",
  );
  const manifest = parseConformanceJson(
    readConformanceText(path.join(root, "manifest.json")),
    "manifest.json",
    () => false,
  );
  if (typeof manifest !== "object" || manifest === null) {
    return {
      ok: false,
      version: undefined,
      expectedVersion: EXPECTED_VERSION,
      versionMatches: false,
      fileCount: actual.length,
      mismatches: ["manifest.json: not an object"],
    };
  }
  const record = manifest as { [key: string]: unknown };
  const version =
    typeof record.version === "string" ? record.version : undefined;
  const entries: readonly ManifestEntry[] = Array.isArray(record.files)
    ? record.files.filter(isEntry)
    : [];
  const listed = new Map(entries.map((e) => [e.path, e.sha256]));
  const versionMatches = version === EXPECTED_VERSION;
  const mismatches = [
    ...(record.format === "manifest" ? [] : ["manifest.json: format"]),
    ...(Array.isArray(record.files) && entries.length === record.files.length
      ? []
      : ["manifest.json: files is malformed"]),
    ...actual.flatMap((f) =>
      !listed.has(f)
        ? [`${f}: not listed in manifest`]
        : listed.get(f) !== sha256Of(path.join(root, f))
          ? [`${f}: sha256 mismatch`]
          : [],
    ),
    ...entries
      .filter((e) => !actual.includes(e.path))
      .map((e) => `${e.path}: listed in manifest but missing`),
    ...(entries.every((e, i) => i === 0 || entries[i - 1].path < e.path)
      ? []
      : ["manifest.json: files are not sorted by path"]),
  ];
  return {
    ok: mismatches.length === 0 && versionMatches,
    version,
    expectedVersion: EXPECTED_VERSION,
    versionMatches,
    fileCount: actual.length,
    mismatches,
  };
}
