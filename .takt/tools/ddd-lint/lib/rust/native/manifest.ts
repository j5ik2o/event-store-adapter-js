/**
 * The one installed location of the native extractor, shared by every entry that launches it.
 *
 * The manifest records the platforms this distribution actually ships a build for. A platform
 * without a row is not covered: resolution reports that instead of pointing at a path that was
 * never installed. The recorded Rust target triple is read here so no gate path needs `rustc`.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** `bin/` sits beside `lib/` in the distributed `tools/ddd/` tree, so one relative step resolves it. */
export const NATIVE_BIN_DIR = resolve(import.meta.dir, "../../../bin");
export const PLATFORM_KEY = `${process.platform}-${process.arch}`;
export const EXTRACTOR_NAME = "ddd-rust-syn-spike";
export const MANIFEST_NAME = "manifest.json";

export interface ResolvedPlatform {
  /** The Rust target triple this build was produced for. */
  readonly target: string;
  readonly sha256: string;
  readonly binaryPath: string;
}

function readManifest(binDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(binDir, MANIFEST_NAME), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${MANIFEST_NAME} is not a platform map`);
  return parsed as Record<string, unknown>;
}

/** Returns the recorded build for `platformKey`, or null when this distribution does not cover it. */
export function resolvePlatform(binDir: string, platformKey: string): ResolvedPlatform | null {
  const row: unknown = readManifest(binDir)[platformKey];
  if (row === undefined) return null;
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error(`${MANIFEST_NAME} records an invalid entry for ${platformKey}`);
  const { target, sha256 } = row as Record<string, unknown>;
  if (typeof target !== "string" || !target || !/^[0-9a-f]{64}$/.test(String(sha256)))
    throw new Error(`${MANIFEST_NAME} records an invalid target or digest for ${platformKey}`);
  return { target, sha256: sha256 as string, binaryPath: join(binDir, platformKey, EXTRACTOR_NAME) };
}
