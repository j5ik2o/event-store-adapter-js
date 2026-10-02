/**
 * Decides, once per launch, whether the installed native extractor can be started for one protocol.
 *
 * Every entry shares this classification so the conditions an inspection must distinguish — an
 * uncovered platform, an absent file, a file without an execute bit, bytes that do not match the
 * recorded digest, a probe that never completed, and an extractor that answers another protocol —
 * are named in one place and projected into one reported issue.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ReasonCode } from "../../state-exposure/index.ts";
import { DEFAULT_LIMITS, observeProcess } from "../../state-exposure-verification/process.ts";
import { resolvePlatform } from "./manifest.ts";

export interface NativeProtocol {
  /** The argument that makes the extractor report its identity, e.g. `--error-contract-version`. */
  readonly flag: string;
  readonly version: number;
}

/** The identity an extractor reports for a protocol probe. */
export interface NativeVersion {
  readonly protocolVersion: number;
  readonly extractor: string;
  readonly syn: string;
}

export type NativeFailureKind =
  | "unsupported-platform"
  | "binary-missing"
  | "binary-not-executable"
  | "checksum-mismatch"
  | "probe-failed"
  | "protocol-mismatch";

/**
 * Structurally the `Issue` of both inspection contracts. Its code is the `state-exposure` reason
 * code because those are exactly the codes the two contracts share, so one reported issue is
 * accepted by either entry and a reason an observation already carries can keep its own code.
 */
export interface NativeIssue {
  readonly code: ReasonCode;
  readonly subject: string;
  readonly message: string;
  readonly location: null;
}

/** A failure carries the code it will be reported under, so one outcome decides the whole report. */
export type NativeOutcome =
  | { readonly kind: "ready"; readonly binaryPath: string; readonly version: NativeVersion }
  | {
      readonly kind: NativeFailureKind;
      readonly binaryPath: string | null;
      readonly code: NativeIssue["code"];
      readonly detail: string;
    };

function parseVersion(response: unknown): NativeVersion | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const { protocol_version, extractor, syn } = response as Record<string, unknown>;
  if (typeof protocol_version !== "number" || typeof extractor !== "string" || typeof syn !== "string") return null;
  return { protocolVersion: protocol_version, extractor, syn };
}

/**
 * The conditions are tested in a fixed order because each one presupposes the previous: an absent
 * file cannot be hashed, a file without an execute bit cannot be probed, and only a probe that
 * completed can disagree about the protocol. The first condition that holds is the one outcome
 * reported.
 */
export async function classifyNativeExtractor(
  binDir: string,
  platformKey: string,
  protocol: NativeProtocol,
): Promise<NativeOutcome> {
  const platform = resolvePlatform(binDir, platformKey);
  if (!platform)
    return {
      kind: "unsupported-platform",
      binaryPath: null,
      code: "tool-unavailable",
      detail: `this distribution records no native extractor for ${platformKey}`,
    };

  const installed = statSync(platform.binaryPath, { throwIfNoEntry: false });
  if (!installed?.isFile())
    return {
      kind: "binary-missing",
      binaryPath: platform.binaryPath,
      code: "tool-unavailable",
      detail: `the native extractor is not installed at ${platform.binaryPath}`,
    };
  if ((installed.mode & 0o111) === 0)
    return {
      kind: "binary-not-executable",
      binaryPath: platform.binaryPath,
      code: "tool-unavailable",
      detail: `the installed native extractor carries no execute permission: ${platform.binaryPath}`,
    };

  const digest = createHash("sha256").update(readFileSync(platform.binaryPath)).digest("hex");
  if (digest !== platform.sha256)
    return {
      kind: "checksum-mismatch",
      binaryPath: platform.binaryPath,
      code: "tool-unavailable",
      detail: `the installed native extractor hashes to ${digest}, not the recorded ${platform.sha256}`,
    };

  const observed = await observeProcess([platform.binaryPath, protocol.flag], "", DEFAULT_LIMITS);
  if (observed.execution.status !== "completed") {
    // The observation has already classified why the probe did not complete, and it reports that as
    // one reason; carrying that reason through keeps a probe that never answered distinct from an
    // answer about another protocol, which is the only thing the next conditions can decide.
    const [observedReason] = observed.execution.reasons;
    return {
      kind: "probe-failed",
      binaryPath: platform.binaryPath,
      code: observedReason.code,
      detail: `the installed native extractor did not complete ${protocol.flag}: ${observedReason.message}`,
    };
  }
  const mismatch = (reported: string): NativeOutcome => ({
    kind: "protocol-mismatch",
    binaryPath: platform.binaryPath,
    code: "unknown-version",
    detail: `${protocol.flag} expects protocol ${protocol.version}; the installed extractor reported ${reported}`,
  });
  const version = parseVersion(observed.execution.response);
  if (!version) return mismatch("an answer that is not a version record");
  if (version.protocolVersion !== protocol.version) return mismatch(`protocol ${version.protocolVersion}`);
  return { kind: "ready", binaryPath: platform.binaryPath, version };
}

/** Projects the one classified outcome into the one issue an inspection reports for it. */
export function nativeIssue(outcome: NativeOutcome): NativeIssue {
  if (outcome.kind === "ready") throw new Error("a launchable native extractor has no issue to report");
  return {
    code: outcome.code,
    subject: `native-extractor:${outcome.kind}`,
    message: outcome.detail,
    location: null,
  };
}
