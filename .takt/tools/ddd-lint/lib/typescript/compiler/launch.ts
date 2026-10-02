/**
 * Decides, once per launch, whether the TypeScript fact extraction can start for one project.
 *
 * The extraction runs on the Compiler API the distribution carries beside this file, never on a
 * `typescript` package the installed project may or may not have. The conditions an inspection must
 * tell apart — no recorded compiler, bytes that do not match the recorded digest, a compiler that
 * does not load, a compiler of another version, and a project outside the supported compiler
 * settings — are named here and projected into one reported issue, in the shape the native
 * extractor reports its own launch conditions.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ReasonCode } from "../../state-exposure/index.ts";
import { type CompilerApi, Refusal, readCompilerCondition, SUPPORTED_COMPILER_API_VERSION } from "./settings.ts";

/** `bundled/` sits beside `compiler/` in `lib/typescript/`. It is not named `vendor/`, which many global gitignores drop. */
export const TYPESCRIPT_VENDOR_DIR = resolve(import.meta.dir, "../bundled");
export const COMPILER_NAME = "typescript.js";
export const MANIFEST_NAME = "manifest.json";

export type TypeScriptExtractorFailureKind =
  | "compiler-missing"
  | "checksum-mismatch"
  | "load-failed"
  | "version-mismatch"
  | "project-condition-mismatch";

/** Structurally the issue the native extractor reports, so an entry reports both alike. */
export interface TypeScriptExtractorIssue {
  readonly code: ReasonCode;
  readonly subject: string;
  readonly message: string;
  readonly location: null;
}

/** A failure carries the code it will be reported under, so one outcome decides the whole report. */
export type TypeScriptExtractorOutcome =
  | TypeScriptExtractorReady
  | { readonly kind: TypeScriptExtractorFailureKind; readonly code: ReasonCode; readonly detail: string };

/** A launch that passed every condition. The compiler it verified stays inside `lib/typescript`. */
export interface TypeScriptExtractorReady {
  readonly kind: "ready";
}

/** Each ready outcome this module classified -> the compiler whose digest and version it verified. */
const verifiedCompilers = new WeakMap<TypeScriptExtractorReady, CompilerApi>();

/**
 * The compiler a ready outcome was classified with. Only the fact extraction in `domain-facts/`
 * calls this: the Compiler API is an implementation detail of the TypeScript inspections, so it is
 * handed between them here rather than carried on the outcome every entry sees. An outcome this
 * module did not classify names no verified compiler, so it is refused rather than read.
 */
export function verifiedCompilerOf(outcome: TypeScriptExtractorReady): CompilerApi {
  const compiler = verifiedCompilers.get(outcome);
  if (!compiler) throw new Error("this ready outcome was not classified by classifyTypeScriptExtractor");
  return compiler;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The digest the manifest records for the compiler, or why the distribution records none. */
function recordedDigest(vendorDir: string): { readonly sha256: string } | { readonly absent: string } {
  const manifestPath = join(vendorDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { absent: `${manifestPath} is not there` };
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { absent: `${manifestPath} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const row =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)[COMPILER_NAME]
      : undefined;
  const sha256 = row && typeof row === "object" ? (row as Record<string, unknown>).sha256 : undefined;
  if (typeof sha256 !== "string" || !SHA256.test(sha256))
    return { absent: `${manifestPath} records no sha256 digest for ${COMPILER_NAME}` };
  return { sha256 };
}

/**
 * The conditions are tested in a fixed order because each one presupposes the previous: a compiler
 * the manifest does not record cannot be verified, bytes are verified before they are evaluated so
 * changed code never runs, only a loaded compiler reports a version, and only the supported version
 * reads the project settings. The first condition that holds is the one outcome reported.
 */
export function classifyTypeScriptExtractor(
  workspaceRoot: string,
  vendorDir: string = TYPESCRIPT_VENDOR_DIR,
): TypeScriptExtractorOutcome {
  const compilerPath = join(vendorDir, COMPILER_NAME);
  const recorded = recordedDigest(vendorDir);
  if ("absent" in recorded)
    return {
      kind: "compiler-missing",
      code: "tool-unavailable",
      detail: `this distribution records no TypeScript compiler: ${recorded.absent}`,
    };
  if (!statSync(compilerPath, { throwIfNoEntry: false })?.isFile())
    return {
      kind: "compiler-missing",
      code: "tool-unavailable",
      detail: `the TypeScript compiler is not installed at ${compilerPath}`,
    };

  const digest = createHash("sha256").update(readFileSync(compilerPath)).digest("hex");
  if (digest !== recorded.sha256)
    return {
      kind: "checksum-mismatch",
      code: "tool-unavailable",
      detail: `the installed TypeScript compiler hashes to ${digest}, not the recorded ${recorded.sha256}`,
    };

  let loaded: unknown;
  try {
    loaded = createRequire(import.meta.url)(compilerPath);
  } catch (error) {
    return {
      kind: "load-failed",
      code: "tool-unavailable",
      detail: `the installed TypeScript compiler did not load: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const version = loaded && typeof loaded === "object" ? (loaded as { version?: unknown }).version : undefined;
  if (version !== SUPPORTED_COMPILER_API_VERSION)
    return {
      kind: "version-mismatch",
      code: "unknown-version",
      detail: `the TypeScript fact extraction supports Compiler API ${SUPPORTED_COMPILER_API_VERSION}; the installed compiler reports ${typeof version === "string" ? version : "no version"}`,
    };
  const compiler = loaded as CompilerApi;

  try {
    readCompilerCondition(compiler, workspaceRoot);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      kind: "project-condition-mismatch",
      code: error.code,
      detail: `the inspected project is outside the supported compiler settings at ${error.subject}: ${error.message}`,
    };
  }
  const ready: TypeScriptExtractorReady = { kind: "ready" };
  verifiedCompilers.set(ready, compiler);
  return ready;
}

/** Projects the one classified outcome into the one issue an inspection reports for it. */
export function typeScriptExtractorIssue(outcome: TypeScriptExtractorOutcome): TypeScriptExtractorIssue {
  if (outcome.kind === "ready") throw new Error("a launchable TypeScript extractor has no issue to report");
  return {
    code: outcome.code,
    subject: `typescript-extractor:${outcome.kind}`,
    message: outcome.detail,
    location: null,
  };
}
