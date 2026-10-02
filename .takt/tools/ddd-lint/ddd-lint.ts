#!/usr/bin/env bun
/**
 * ddd-lint — checks a project's DDD model files and its Rust / TypeScript code against the DDD
 * conventions.
 *
 *   bun ddd-lint.ts [--project <root>] [--json]
 *
 * Reads `.ddd.toml` and `docs/ddd/{domain-model,aggregate-mapping,layer-structure}.yaml` from the
 * project root, then checks the code of every language `.ddd.toml` lists.
 *
 * Exit status: 0 when nothing is found, 1 when there are findings or a check cannot decide the code
 * (a construct it cannot inspect, a missing compiler or extractor), 2 on a usage error.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadAggregateMapping } from "./lib/aggregate-mapping/index.ts";
import { inspectLayerDeclaration, loadLayerDeclaration } from "./lib/layer-declaration/index.ts";
import { readLayoutSelection } from "./lib/module-layout/settings.ts";
import { checkModuleLayout } from "./lib/module-layout/check.ts";
import { checkTypeScriptModuleLayout } from "./lib/module-layout/typescript.ts";
import {
  BudgetExceededError,
  checkApi,
  finding,
  type ProjectContext,
  projectContext,
  projectSources,
  relPath,
  ToolUnavailableError,
} from "./lib/project/context.ts";
import { DOCUMENT_NAME, type ProjectSelection } from "./lib/project-settings/contract.ts";
import { evaluateRustChecks as evaluateRust } from "./lib/rules/evaluate.ts";
import {
  evaluateTypeScriptDomain,
  evaluateTypeScriptInterfaceAdapter,
  evaluateTypeScriptUseCase,
} from "./lib/rules/typescript/evaluate.ts";
import { workspacePackages } from "./lib/rules/typescript/packages.ts";
import { classifyDomainFactExtractor } from "./lib/rust/domain-facts/index.ts";
import { LAYER_FILE, MAPPING_FILE, MODEL_FILE } from "./lib/schema/artifacts.ts";
import { checkCompleteness } from "./lib/schema/completeness.ts";
import { loadDomainModel } from "./lib/schema/loader.ts";
import { collectUnresolved } from "./lib/schema/unresolved.ts";
import type { FindingInput } from "./lib/shared/findings.ts";
import type { PackageIdentity } from "./lib/layer-declaration/contract.ts";
import { assignLayers, scanWorkspace } from "./lib/workspace/resolver.ts";

interface CheckResult {
  readonly check: string;
  readonly findings: readonly FindingInput[];
  readonly note?: string;
  /** Why the check could not decide the code; the run fails, since nothing was proven. */
  readonly unavailable?: string;
}

function usage(message: string): never {
  process.stderr.write(`${message}\nUsage: bun ddd-lint.ts [--project <root>] [--json]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { root: string; json: boolean } {
  let root = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") root = resolve(argv[++i] ?? usage("--project needs a directory"));
    else if (arg === "--json") json = true;
    else usage(`unknown argument: ${arg}`);
  }
  if (!existsSync(root)) usage(`no such directory: ${root}`);
  return { root, json };
}

/** Runs one check, turning a check that cannot decide into a result instead of a crash. */
async function run(check: string, body: () => Promise<Omit<CheckResult, "check">> | Omit<CheckResult, "check">) {
  try {
    return { check, ...(await body()) };
  } catch (error) {
    if (error instanceof ToolUnavailableError) return { check, findings: [], unavailable: error.message };
    if (error instanceof BudgetExceededError) return { check, findings: [], unavailable: "time budget exceeded" };
    return { check, findings: [], unavailable: `internal error: ${error instanceof Error ? error.message : error}` };
  }
}

function checkModel(context: ProjectContext): Omit<CheckResult, "check"> {
  const path = join(context.modelDir, MODEL_FILE);
  const file = relPath(context, path);
  if (!existsSync(path)) return { findings: [finding("model.missing", file, `${MODEL_FILE} is missing`)] };
  const loaded = loadDomainModel(path);
  if (!loaded.ok) return { findings: loaded.findings.map((entry) => ({ ...entry, file })) };
  return {
    findings: [
      ...checkCompleteness(loaded.model, file),
      ...collectUnresolved(loaded.model, loaded.index).map((reference) =>
        finding("model.unresolved", file, `unresolved reference ${reference.id} (${reference.reason})`),
      ),
    ],
  };
}

function checkMapping(context: ProjectContext): Omit<CheckResult, "check"> {
  const path = join(context.modelDir, MAPPING_FILE);
  const file = relPath(context, path);
  if (!existsSync(path)) return { findings: [finding("mapping.missing", file, `${MAPPING_FILE} is missing`)] };
  const loaded = loadAggregateMapping(path);
  return { findings: loaded.ok ? [] : loaded.findings.map((entry) => ({ ...entry, file })) };
}

function checkLayers(context: ProjectContext): Omit<CheckResult, "check"> {
  const path = join(context.modelDir, LAYER_FILE);
  const file = relPath(context, path);
  if (!existsSync(path)) return { findings: [finding("layer.missing", file, `${LAYER_FILE} is missing`)] };
  const loaded = loadLayerDeclaration(path);
  if (!loaded.ok) return { findings: loaded.findings.map((entry) => ({ ...entry, file })) };
  // A mapping declares business ownership, not the package's layer. Resolve the same manifest
  // names and placements the language checks use before granting the aggregate-only exception.
  const domainPackages: PackageIdentity[] = workspacePackages(context.root)
    .filter((pkg) => pkg.assignment.layer === "domain")
    .map((pkg) => ({ language: "typescript", package: pkg.name }));
  const seenCrates = new Set<string>();
  for (const manifest of projectSources(context, [".toml"])) {
    if (!manifest.resolved_path || basename(manifest.path) !== "Cargo.toml") continue;
    const root = dirname(manifest.resolved_path);
    for (const assignment of assignLayers(scanWorkspace(root))) {
      const cratePath = resolve(root, assignment.path);
      if (seenCrates.has(cratePath)) continue;
      seenCrates.add(cratePath);
      if (assignment.layer === "domain")
        domainPackages.push({ language: "rust", package: assignment.crate_name });
    }
  }
  return { findings: inspectLayerDeclaration(loaded.declaration, loaded.model, file, domainPackages) };
}

async function checkRust(context: ProjectContext): Promise<CheckResult[]> {
  const extractor = await classifyDomainFactExtractor();
  const api = checkApi(context);
  const gate = (
    target_layers: ("domain" | "use-case" | "interface-adapter" | "rmu")[],
    includes_query_side: boolean,
    rules: string[],
    report_layer_diagnostics = false,
  ) => evaluateRust(context, { target_layers, includes_query_side, report_layer_diagnostics, domain_facts: extractor }, rules, api);
  return Promise.all([
    run("rust-domain", () => gate(["domain"], false, ["a", "b", "operation", "in-place", "collection", "port-placement", "c", "d", "g", "domain-packaging"], true)),
    run("rust-use-case", () => gate(["use-case"], false, ["g", "h", "i", "d", "use-case-name"])),
    run("rust-interface-adapter", () => gate(["interface-adapter", "rmu"], true, ["k", "l", "m", "n", "g"])),
    run("rust-module-layout", () => {
      const result = checkModuleLayout(extractor, context.root, () => api.checkBudget());
      return { findings: result.findings, note: `${result.mode ?? "no Rust project"}; ${result.crates} crates` };
    }),
  ]);
}

async function checkTypeScript(context: ProjectContext): Promise<CheckResult[]> {
  const api = checkApi(context);
  return Promise.all([
    run("typescript-domain", () => evaluateTypeScriptDomain(context, api)),
    run("typescript-use-case", () => evaluateTypeScriptUseCase(context, api)),
    run("typescript-interface-adapter", () => evaluateTypeScriptInterfaceAdapter(context, api)),
    run("typescript-module-layout", () => {
      const result = checkTypeScriptModuleLayout(context.root, () => api.checkBudget());
      return { findings: result.findings, note: `${result.mode ?? "no TypeScript project"}; ${result.packages} packages` };
    }),
  ]);
}

async function main(): Promise<number> {
  const { root, json } = parseArgs(process.argv.slice(2));
  const context = projectContext(root);
  const results: CheckResult[] = [];

  const settingsPath = join(root, DOCUMENT_NAME);
  let selection: ProjectSelection | undefined;
  if (!existsSync(settingsPath)) {
    results.push({ check: "settings", findings: [finding("settings.missing", DOCUMENT_NAME, `${DOCUMENT_NAME} is missing`)] });
  } else {
    const read = readLayoutSelection(settingsPath);
    if ("message" in read) results.push({ check: "settings", findings: [finding("settings.invalid", DOCUMENT_NAME, read.message)] });
    else selection = read;
  }

  results.push(await run("model", () => checkModel(context)));
  results.push(await run("mapping", () => checkMapping(context)));
  results.push(await run("layers", () => checkLayers(context)));
  if (selection?.languages.includes("rust")) results.push(...(await checkRust(context)));
  if (selection?.languages.includes("typescript")) results.push(...(await checkTypeScript(context)));

  const findings = results.flatMap((result) => result.findings.map((entry) => ({ check: result.check, ...entry })));
  const unavailable = results.filter((result) => result.unavailable !== undefined);
  if (json) {
    process.stdout.write(`${JSON.stringify({ pass: findings.length === 0 && unavailable.length === 0, results })}\n`);
  } else {
    for (const entry of findings) {
      const at = entry.line === undefined ? entry.file : `${entry.file}:${entry.line}`;
      process.stdout.write(`${at}: [${entry.rule_id}] ${entry.message}\n`);
    }
    for (const result of unavailable) process.stdout.write(`(${result.check}) cannot decide: ${result.unavailable}\n`);
    for (const result of results) if (result.note) process.stderr.write(`(${result.check}) ${result.note}\n`);
    process.stdout.write(
      findings.length === 0 && unavailable.length === 0
        ? "ddd-lint: no findings\n"
        : `ddd-lint: ${findings.length} finding(s), ${unavailable.length} check(s) could not decide\n`,
    );
  }
  return findings.length === 0 && unavailable.length === 0 ? 0 : 1;
}

process.exit(await main());
