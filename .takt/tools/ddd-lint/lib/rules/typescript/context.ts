/**
 * Assembles what the TypeScript rules of one gate are evaluated over from one run of it.
 *
 * The checked `.ts` / `.tsx` sources name the packages the change touches; the sources among them
 * of the layers the gate decides are the files the per-file rules decide. Only once there is one is
 * the compiler classified: a run with no TypeScript source, or with no such source among them,
 * answers without it.
 *
 * The rules decide from more than the checked files — a type declared in any domain source can be
 * constructed, called or replayed in a checked one, and a use case or a port declared in any
 * use-case source can be called from one — so the facts are read for every source of every package
 * of the layers the gate describes that is checked or referenced by the root `tsconfig.json`, and a
 * source among them the extraction could not read, or read with a construct left unresolved, stops
 * the gate: the answer would otherwise be given over a program the facts do not describe. A
 * dependency is judged against every package of the workspace, referenced or not.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadMappingView } from "../../aggregate-mapping/index.ts";
import { projectSources, type ProjectContext } from "../../project/context.ts";
import { ToolUnavailableError } from "../../project/context.ts";
import { finding, relPath } from "../../project/context.ts";
import type { FindingInput } from "../../shared/findings.ts";
import { classifyTypeScriptExtractor } from "../../typescript/compiler/launch.ts";
import {
  requireTypeScriptFacts,
  type TypeScriptFactSet,
  type TypeScriptSourceFile,
} from "../../typescript/domain-facts/index.ts";
import { readTypeScriptProject } from "../../typescript/domain-facts/project.ts";
import { readModelAvailability } from "../model.ts";
import type { ProjectPackages } from "./edges.ts";
import {
  isTypeScriptSource,
  owningPackageRoot,
  packageSources,
  posixRelative,
  readPackage,
  roleOf,
  type TsPackage,
  workspacePackages,
} from "./packages.ts";
import { buildDeclarationTable, buildSymbolTable } from "./symbols.ts";
import { type TsGate, type TsInspection, type TsTarget, Undecided } from "./types.ts";

const NO_TYPESCRIPT_SOURCE = "no TypeScript sources";

type InspectionResult =
  | { readonly kind: "empty"; readonly note: string }
  /** Sources that include no domain source, with what they still report: unowned files, layer diagnostics. */
  | { readonly kind: "findings-only"; readonly findings: FindingInput[]; readonly note?: string }
  | {
      readonly kind: "ready";
      readonly inspection: TsInspection;
      readonly findings: FindingInput[];
      readonly note?: string;
    };

function layerDiagnostics(packages: Iterable<TsPackage>): FindingInput[] {
  return [...packages].flatMap((pkg) =>
    pkg.assignment.diagnostics.map((diagnostic) => ({
      rule_id: diagnostic.code,
      file: diagnostic.file,
      message: diagnostic.message,
    })),
  );
}

/**
 * Every source the rules decide from, read. A source that cannot be read is still named, so the
 * decision base reports it as unread rather than the rules deciding without it.
 */
function readSources(files: readonly string[], workspaceRoot: string): TypeScriptSourceFile[] {
  return files.flatMap((file) => {
    try {
      return [{ file, source: readFileSync(join(workspaceRoot, file), "utf-8") }];
    } catch {
      return [];
    }
  });
}

/** Stops the gate when a source the rules decide from was not read, or was read with a construct left unresolved. */
function requireDecisionBase(gate: TsGate, facts: TypeScriptFactSet, decidedFrom: readonly string[]): void {
  const unread = decidedFrom.filter(
    (file) =>
      !facts.files.has(file) && !facts.notes.some((note) => note.startsWith(`domain-facts.unresolved: ${file}:`)),
  );
  const reasons = [...facts.notes, ...unread.map((file) => `${file} was not read`)];
  if (reasons.length > 0)
    throw new ToolUnavailableError(
      `the TypeScript facts do not describe every source the ${gate.label} rules decide from, so they cannot be decided: ${reasons.join("; ")}`,
    );
}

/** Whether the gate's per-file rules decide the sources of `pkg`. */
function decides(gate: TsGate, pkg: TsPackage): boolean {
  return (
    gate.target_layers.includes(pkg.assignment.layer) ||
    (gate.includes_query_side && pkg.assignment.cqrs_side === "query")
  );
}

export function assembleTypeScriptInspection(run: ProjectContext, gate: TsGate): InspectionResult {
  const findings: FindingInput[] = [];
  const sourceFiles = projectSources(run, [".ts", ".tsx"]).filter(
    (sourceFile) => sourceFile.resolved_path && isTypeScriptSource(sourceFile.path),
  );
  if (sourceFiles.length === 0) return { kind: "empty", note: NO_TYPESCRIPT_SOURCE };

  const workspaceRoot = run.root;
  const packages = new Map<string, TsPackage>();
  const targets: TsTarget[] = [];
  let skipped = 0;
  for (const sourceFile of sourceFiles) {
    const path = sourceFile.resolved_path as string;
    const root = owningPackageRoot(workspaceRoot, path);
    const pkg = root === undefined ? { problem: "no package.json owns it" } : readPackage(workspaceRoot, root);
    if ("problem" in pkg) {
      findings.push(finding("layer.unowned", relPath(run, path), `file has no package: ${pkg.problem}`));
      continue;
    }
    packages.set(pkg.root, pkg);
    if (roleOf(pkg, path) === "source" && decides(gate, pkg))
      targets.push({ file: posixRelative(workspaceRoot, path), pkg });
    else skipped++;
  }
  const sourcePackages = [...packages.values()];
  const skippedNote = skipped > 0 ? `${skipped} non-target files skipped` : undefined;
  const availability = readModelAvailability(run);
  findings.push(...availability.findings);
  if (targets.length === 0) {
    const reported = [...findings, ...(gate.reports_layer_diagnostics ? layerDiagnostics(sourcePackages) : [])];
    if (reported.length === 0) return { kind: "empty", note: NO_TYPESCRIPT_SOURCE };
    return { kind: "findings-only", findings: reported, ...(skippedNote ? { note: skippedNote } : {}) };
  }

  // Every rule of the gate decides on the extracted facts, so the compiler is required exactly
  // where those rules have a checked source to decide.
  const extractor = classifyTypeScriptExtractor(workspaceRoot);
  const project = readTypeScriptProject(extractor, workspaceRoot);
  for (const config of project.packages) {
    const root = resolve(config.root);
    if (packages.has(root)) continue;
    const pkg = readPackage(workspaceRoot, root);
    // A referenced directory that declares no package cannot be named by an import; a path into it
    // is left undecided where it is written.
    if (!("problem" in pkg)) packages.set(root, pkg);
  }
  const configs = new Map(project.packages.map((config) => [resolve(config.root), config]));
  const described = new Set(
    [...packages.values()]
      .filter((pkg) => gate.described_layers.includes(pkg.assignment.layer) && !pkg.assignment.is_composition_root)
      .map((pkg) => pkg.root),
  );
  // A dependency is judged by the package it names wherever that package is in the workspace; only
  // the facts are limited to the packages checked or referenced.
  const everyPackage = new Map(packages);
  for (const pkg of workspacePackages(workspaceRoot)) if (!everyPackage.has(pkg.root)) everyPackage.set(pkg.root, pkg);
  const projectPackages: ProjectPackages = {
    workspaceRoot,
    list: [...everyPackage.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
    configs,
    described,
  };
  // The compiler settings, and so the aliases a source of the package resolves through, are only
  // known for a package the root `tsconfig.json` references; the launch never checked any other.
  const unreferenced = [...new Set(targets.map((target) => target.pkg))].filter((pkg) => !configs.has(pkg.root));
  if (unreferenced.length > 0)
    throw new ToolUnavailableError(
      `the root tsconfig.json does not reference ${unreferenced.map((pkg) => pkg.path).join(", ")}, so the settings its ${gate.label} sources are compiled with are not known`,
    );

  const decidedFrom = new Set(targets.map((target) => target.file));
  for (const pkg of projectPackages.list)
    if (described.has(pkg.root))
      for (const source of packageSources(pkg)) decidedFrom.add(posixRelative(workspaceRoot, source));
  const decided = [...decidedFrom].sort((a, b) => a.localeCompare(b, "en"));
  const facts = requireTypeScriptFacts(extractor, readSources(decided, workspaceRoot));
  requireDecisionBase(gate, facts, decided);

  const mapping = loadMappingView(run.modelDir, "typescript");
  const notes = new Set<string>();
  if (mapping.kind === "invalid") notes.add("replay.disabled: aggregate mapping is invalid");
  const noteParts = [skippedNote, availability.model.note].filter((part): part is string => part !== undefined);
  return {
    kind: "ready",
    inspection: {
      run,
      packages: projectPackages,
      targets: targets.sort((a, b) => a.file.localeCompare(b.file, "en")),
      facts,
      symbols: buildSymbolTable(projectPackages, facts.files),
      declarations: buildDeclarationTable(projectPackages, facts.files),
      model: availability.model,
      mapping,
      notes,
      undecided: new Undecided(),
      layerDiagnostics: layerDiagnostics(sourcePackages),
    },
    findings,
    ...(noteParts.length > 0 ? { note: noteParts.join("; ") } : {}),
  };
}
