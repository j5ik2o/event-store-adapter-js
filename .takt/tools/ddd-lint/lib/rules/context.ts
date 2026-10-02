/**
 * InspectionContext assembly — turns a run context into the facts the
 * rule evaluators consume.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRustSource, rustSourcesUnder } from "../packaging/rust-modules.ts";
import { projectSources, type ProjectContext } from "../project/context.ts";
import { ToolUnavailableError } from "../project/context.ts";
import { type DomainFactSet, type RustSourceFile, requireDomainFacts } from "../rust/domain-facts/index.ts";
import type { NativeOutcome } from "../rust/native/launch.ts";
import { finding, relPath } from "../project/context.ts";
import type { FindingInput } from "../shared/findings.ts";
import { assignLayers, classifyFile, type Layer, scanWorkspace } from "../workspace/resolver.ts";
import { IO_CRATES } from "./lists.ts";
import { readModelAvailability } from "./model.ts";
import { buildEdges } from "./rust/edges.ts";
import { loadRustMapping } from "./rust/mapping.ts";
import { buildProgram, collectRustSources, PROGRAM_LAYERS } from "./rust/program.ts";
import { buildSymbolTable } from "./rust/symbols.ts";
import type { InspectionContext, InspectionTarget, ModelAvailability } from "./types.ts";

export interface CheckConfig {
  target_layers: readonly Layer[];
  includes_query_side: boolean;
  report_layer_diagnostics?: boolean;
  /**
   * The native extractor every Rust rule decides on, as the command line classified it. A
   * classification that is not `ready` decides nothing on its own: it stops this run only once
   * those rules have a file to decide on.
   */
  domain_facts: NativeOutcome;
}

export type ContextResult =
  | { kind: "empty"; note: string }
  | { kind: "failed"; findings: FindingInput[]; note?: string }
  | { kind: "ready"; context: InspectionContext; findings: FindingInput[]; note?: string };

function findWorkspaceRoot(filePath: string): { root: string; isWorkspace: boolean } | undefined {
  let current = dirname(filePath);
  let packageCandidate: string | undefined;
  for (let i = 0; i < 50; i++) {
    const cargo = join(current, "Cargo.toml");
    if (existsSync(cargo)) {
      try {
        const parsed = Bun.TOML.parse(readFileSync(cargo, "utf-8")) as Record<string, unknown>;
        if (parsed.workspace !== undefined) return { root: current, isWorkspace: true };
        if (parsed.package !== undefined && packageCandidate === undefined) packageCandidate = current;
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return packageCandidate ? { root: packageCandidate, isWorkspace: false } : undefined;
}

/**
 * The rules an attribute macro leaves undecidable. An attribute macro replaces the item it
 * annotates, so it can add the public member rule (a) reports or the getter rule (d) reports, and
 * the declarations the extractor read are then not the ones the program has. A gate that runs (a) or
 * (d) stops as a whole on such a file, so none of its rules is evaluated; a gate that runs neither
 * keeps the file as a note.
 */
const ATTRIBUTE_MACRO_RULES: readonly string[] = ["a", "d"];

/**
 * Stops the inspection when a file the rules are decided from carries no declarations, or carries an
 * attribute that may be an attribute macro while `attributeMacroRules` — the rules among (a) and (d)
 * this gate runs — is not empty.
 *
 * `decidedFrom` names those files: the checked files the per-file rules run over, and every source
 * the program is built from, because a declaration hidden in any of them changes what the whole
 * program resolves to. A file among them the extractor could not read decides nothing, and stopping
 * here carries the reason the extractor gave for it — a failure raised later, while the rules run,
 * would be reported as an evaluation error and drop that reason. An unread file is reported first:
 * it carries no declarations at all, so whether it carries an attribute macro is not known.
 */
function requireDecisionBase(
  facts: DomainFactSet,
  decidedFrom: readonly string[],
  attributeMacroRules: readonly string[],
): void {
  const decided = new Set(decidedFrom);
  const unread = [...decided].filter((file) => !facts.files.has(file)).sort();
  if (unread.length > 0) {
    const reasons = facts.notes.filter((note) =>
      unread.some((file) => note.startsWith(`domain-facts.unresolved: ${file}:`)),
    );
    // A file can go unread without the extractor recording a reason for it — a source the batch could
    // not even open carries no note. Naming the files is the answer then, rather than a dangling colon.
    const detail = reasons.length > 0 ? `: ${reasons.join("; ")}` : "";
    throw new ToolUnavailableError(
      `the native extractor did not read ${unread.join(", ")}, so the Rust rules cannot be decided${detail}`,
    );
  }
  if (attributeMacroRules.length === 0) return;
  const attributeMacros = [...facts.files]
    .filter(([file]) => decided.has(file))
    .sort((a, b) => a[0].localeCompare(b[0], "en"))
    .flatMap(([file, fileFacts]) =>
      [...fileFacts.attributeMacros].sort((a, b) => a - b).map((line) => `${file}:${line} attribute-macro`),
    );
  if (attributeMacros.length === 0) return;
  const rules = attributeMacroRules.map((ruleId) => `(${ruleId})`).join(" and ");
  throw new ToolUnavailableError(
    `an attribute macro may replace the item it annotates, so ${attributeMacroRules.length === 1 ? "rule" : "rules"} ${rules} cannot be decided: ${attributeMacros.join("; ")}`,
  );
}

export function assembleContext(
  run: ProjectContext,
  config: CheckConfig,
  ruleIds: readonly string[],
): ContextResult {
  const findings: FindingInput[] = [];
  const rustSources = projectSources(run, [".rs"]).filter((sourceFile) => isRustSource(sourceFile.path));
  if (rustSources.length === 0) return { kind: "empty", note: "no Rust sources" };

  const roots = new Map<string, string[]>();
  for (const sourceFile of rustSources) {
    if (!sourceFile.resolved_path) continue;
    const found = findWorkspaceRoot(sourceFile.resolved_path);
    if (!found) {
      findings.push(
        finding("layer.unowned", relPath(run, sourceFile.resolved_path), "file has no Cargo workspace root"),
      );
      continue;
    }
    const root = found.root;
    if (!root.startsWith(run.root)) {
      findings.push(
        finding("layer.unowned", relPath(run, sourceFile.resolved_path), "workspace root is outside the project root"),
      );
      continue;
    }
    const list = roots.get(root) ?? [];
    list.push(sourceFile.path);
    roots.set(root, list);
  }
  if (roots.size === 0) return { kind: "failed", findings };

  const [workspaceRoot, rootSources] = [...roots.entries()].sort((a, b) => a[0].localeCompare(b[0], "en"))[0];
  if (roots.size > 1) {
    findings.push(
      finding("workspace.multiple-roots", workspaceRoot, "Rust files span more than one Cargo workspace root"),
    );
  }

  const workspace = scanWorkspace(workspaceRoot);
  const assignments = assignLayers(workspace);

  const availability = readModelAvailability(run);
  const model: ModelAvailability = availability.model;
  findings.push(...availability.findings);

  const targets: InspectionTarget[] = [];
  const skipped: InspectionTarget[] = [];
  const sourceByPath = new Map(rustSources.filter((c) => c.resolved_path).map((c) => [c.resolved_path as string, c]));
  const sourceContents = new Map<string, Uint8Array>();

  for (const [root, paths] of [[workspaceRoot, rootSources]] as [string, string[]][]) {
    for (const sourcePath of paths.sort((a, b) => a.localeCompare(b, "en"))) {
      const sourceFile = sourceByPath.get(join(root, sourcePath)) ?? rustSources.find((c) => c.path === sourcePath);
      if (!sourceFile?.resolved_path) continue;
      const file = sourceFile.path;
      const classification = classifyFile(assignments, file);
      const target: InspectionTarget = { sourceFile, classification };
      if (classification.crate_name) target.crate_name = classification.crate_name;
      const inLayer = config.target_layers.includes(classification.effective_layer as Layer);
      const querySide = config.includes_query_side && classification.cqrs_side === "query";
      if (classification.role === "crate-source" && (inLayer || querySide)) {
        try {
          const content = readFileSync(join(root, file));
          target.file = file;
          sourceContents.set(file, content);
        } catch {
          // A file that cannot be read stays a target, without a file of its own: it is still one of
          // the files the rules have to decide, so it keeps the extractor required for this run, and
          // the per-file rules it carries no declarations for report nothing rather than passing it.
        }
        targets.push(target);
      } else {
        skipped.push(target);
      }
    }
  }

  // Every Rust rule decides on the extractor, so it is required exactly where those rules have a
  // file to decide: with no target among the checked files none of them evaluates anything, its
  // classification cannot change this verdict, and an unusable one is not this run's terminal.
  // The program is what those rules are decided over, so it is not built for a run without one.
  const facts: DomainFactSet =
    targets.length > 0
      ? requireDomainFacts(config.domain_facts, batchSources(workspaceRoot, assignments, sourceContents))
      : { files: new Map(), notes: [] };
  // Test code is not business code: a file reached only through a `#[cfg(test)]` module is skipped.
  const testOnly = testOnlyFiles(facts);
  for (let index = targets.length - 1; index >= 0; index--) {
    const file = targets[index].file;
    if (file !== undefined && testOnly.has(file)) skipped.push(...targets.splice(index, 1));
  }
  const collected =
    targets.length > 0
      ? collectRustSources(facts, workspaceRoot, assignments)
      : { crates: [], workspaceCrates: new Set<string>() };
  requireDecisionBase(
    facts,
    [
      ...targets.flatMap((target) => (target.file ? [target.file] : [])),
      ...collected.crates.flatMap((crate) => crate.inventory.sources.map((source) => source.decidedFrom)),
    ],
    ATTRIBUTE_MACRO_RULES.filter((ruleId) => ruleIds.includes(ruleId)),
  );

  const program = buildProgram(collected, facts);
  const rustMapping = loadRustMapping(run.modelDir);
  if (rustMapping.kind === "invalid") program.notes.add("replay.disabled: aggregate mapping is invalid");
  const symbols = buildSymbolTable(program, model, rustMapping.kind === "loaded" ? rustMapping.view.aggregates : []);

  const edges = buildEdges(facts, targets, assignments, workspaceRoot, IO_CRATES);
  const layerDiagnostics = [
    ...workspace.diagnostics.map((d) => ({ code: d.code, file: d.file, message: d.message })),
    ...assignments.flatMap((a) => a.diagnostics.map((d) => ({ code: d.code, file: d.file, message: d.message }))),
  ];

  const noteParts: string[] = [];
  if (skipped.length > 0) noteParts.push(`${skipped.length} files outside ${config.target_layers.join("/")}`);
  noteParts.push(...facts.notes);
  if (model.note) noteParts.push(model.note);

  const context: InspectionContext = {
    rustMapping,
    run,
    workspace,
    assignments,
    targets,
    skipped,
    symbols,
    program,
    model,
    denylist: IO_CRATES,
    edges,
    layerDiagnostics,
    targetLayers: config.target_layers,
    includesQuerySide: config.includes_query_side,
  };
  if (targets.length === 0 && findings.length === 0) {
    return { kind: "empty", note: "no Rust sources" };
  }
  return { kind: "ready", context, findings, ...(noteParts.length > 0 ? { note: noteParts.join("; ") } : {}) };
}

/**
 * The one batch the inspection sends: every Rust source of every crate the program is built from,
 * plus every checked file. The module walk decides which file to open next from the declarations of
 * the one it is on, so the batch covers each program crate's sources in full rather than only the
 * ones a walk has already reached.
 */
function batchSources(
  workspaceRoot: string,
  assignments: readonly { crate_name: string; path: string; layer: Layer }[],
  checked: ReadonlyMap<string, Uint8Array>,
): RustSourceFile[] {
  const decoder = new TextDecoder();
  const sources = new Map<string, string>();
  for (const [file, bytes] of checked) sources.set(file, decoder.decode(bytes));
  for (const assignment of assignments) {
    if (!PROGRAM_LAYERS.includes(assignment.layer)) continue;
    for (const file of rustSourcesUnder(workspaceRoot, join(workspaceRoot, assignment.path))) {
      if (sources.has(file)) continue;
      try {
        sources.set(file, readFileSync(join(workspaceRoot, file), "utf-8"));
      } catch {
        // A source that cannot be read carries no declarations to ask about. The module walk
        // reports it where a declaration names it, which is where it is this crate's defect.
      }
    }
  }
  return [...sources].sort((a, b) => a[0].localeCompare(b[0], "en")).map(([file, source]) => ({ file, source }));
}

/**
 * The files that belong to test code: every `#![cfg(test)]` file, every file a `#[cfg(test)]` module
 * declaration names, and every file a test-only file declares in turn.
 */
function testOnlyFiles(facts: DomainFactSet): Set<string> {
  const testOnly = new Set<string>();
  for (const [file, fileFacts] of facts.files) if (fileFacts.auxiliary) testOnly.add(file);
  const declaredBy = (file: string, name: string): string[] => {
    const base = file.split("/").pop() ?? "";
    const dir = ["lib.rs", "main.rs", "mod.rs"].includes(base) ? dirname(file) : file.replace(/\.rs$/, "");
    return [join(dir, `${name}.rs`), join(dir, name, "mod.rs")].filter((candidate) => facts.files.has(candidate));
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, fileFacts] of facts.files) {
      for (const module of fileFacts.modules) {
        if (module.inline || module.path !== undefined) continue;
        if (!module.auxiliary && !testOnly.has(file)) continue;
        for (const declared of declaredBy(file, module.name)) {
          if (testOnly.has(declared)) continue;
          testOnly.add(declared);
          grew = true;
        }
      }
    }
  }
  return testOnly;
}
