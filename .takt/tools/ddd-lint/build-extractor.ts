#!/usr/bin/env bun
/**
 * Builds the Rust declaration extractor for this machine from `rust-extractor/`, installs it at
 * `bin/<platform>/`, and records the platform in `bin/manifest.json`.
 *
 *   bun build-extractor.ts
 *
 * Needed once on a platform the distribution ships no build for (only `darwin-arm64` is shipped).
 * Requires `cargo`; the first build downloads the extractor's crates.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXTRACTOR_NAME, MANIFEST_NAME, NATIVE_BIN_DIR, PLATFORM_KEY } from "./lib/rust/native/manifest.ts";

const PROTOCOLS = [
  { flag: "--error-contract-version", version: 3 },
  { flag: "--state-exposure-version", version: 2 },
  { flag: "--domain-facts-version", version: 7 },
];

const root = import.meta.dir;

function run(command: string[], timeoutMs = 600_000): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

try {
  const host = /^host: (.+)$/m.exec(run(["rustc", "-vV"]))?.[1];
  if (!host) throw new Error("rustc reports no host target");
  const targetDir = resolve(root, "rust-extractor/target");
  run(["cargo", "build", "--locked", "--release", "--manifest-path", "rust-extractor/Cargo.toml", "--target-dir", targetDir, "--target", host]);

  const built = join(targetDir, host, "release", EXTRACTOR_NAME);
  const installed = join(NATIVE_BIN_DIR, PLATFORM_KEY, EXTRACTOR_NAME);
  mkdirSync(dirname(installed), { recursive: true });
  copyFileSync(built, installed);
  chmodSync(installed, 0o755);

  for (const protocol of PROTOCOLS) {
    const reported = JSON.parse(run([installed, protocol.flag]));
    if (reported.protocol_version !== protocol.version)
      throw new Error(`${protocol.flag} reports protocol ${reported.protocol_version}, expected ${protocol.version}`);
  }

  const manifestPath = join(NATIVE_BIN_DIR, MANIFEST_NAME);
  const rows = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  rows[PLATFORM_KEY] = { target: host, sha256: createHash("sha256").update(readFileSync(installed)).digest("hex") };
  const sorted = Object.fromEntries(Object.keys(rows).sort().map((key) => [key, rows[key]]));
  writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
  process.stderr.write(`built the Rust extractor for ${PLATFORM_KEY} (${host})\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
