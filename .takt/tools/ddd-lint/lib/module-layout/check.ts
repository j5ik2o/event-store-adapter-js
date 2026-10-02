import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { inspectModules, isRustSource } from "../packaging/rust-modules.ts";
import { DOCUMENT_NAME } from "../project-settings/contract.ts";
import { type DomainFactSet, type RustSourceFile, requireDomainFacts } from "../rust/domain-facts/index.ts";
import type { NativeOutcome } from "../rust/native/launch.ts";
import { finding } from "../project/context.ts";
import type { FindingInput } from "../shared/findings.ts";
import { isExcludedFromProjectScan } from "../shared/project-scope.ts";
import { scanWorkspace } from "../workspace/resolver.ts";
import { readLayoutSelection } from "./settings.ts";
import { admitLayoutEntry, readLayoutDirectory } from "./walk.ts";

export type ModuleLayout = "file" | "mod-rs";
const posix = (path: string) => path.split(sep).join("/");
/**
 * Whether the discovery walk above put this project-relative file in the batch sent to the extractor.
 * `discover` descends only into entries the project scan keeps — asking that of one entry name at a
 * time, so a path is reached only when every segment of it was — and among the entries it reaches it
 * collects the Rust sources alone. Both halves have to be asked here: a declaration may name a file
 * Rust accepts and this enumeration does not, and calling such a file unparsable would name a reason
 * for a file that was never asked about.
 */
const coveredByScan = (file: string) => !file.split("/").some(isExcludedFromProjectScan) && isRustSource(file);
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
export interface LayoutResult {
  findings: FindingInput[];
  crates: number;
  files: number;
  mode?: ModuleLayout;
}

/**
 * The declarations of every Rust source this project holds, read in one batch.
 *
 * The module walk decides which file to open next from the declarations of the one it is on, so
 * the batch is sent over the sources the project scan already found rather than over a walk that
 * has not run yet. A file the extractor could not read is left out, and the walk reports it where
 * a declaration names it.
 */
function readProjectFacts(
  extractor: NativeOutcome,
  root: string,
  sources: readonly string[],
  checkBudget: () => void,
): DomainFactSet {
  const batch: RustSourceFile[] = [];
  for (const path of [...sources].sort()) {
    try {
      batch.push({ file: posix(relative(root, path)), source: readFileSync(path, "utf8") });
    } catch {
      // A source that cannot be read carries no declarations to ask about; the walk reports it.
    }
  }
  return requireDomainFacts(extractor, batch, checkBudget);
}

/** Whole-project check: no source list, model, layer assignment, or edition-based style inference. */
export function checkModuleLayout(
  extractor: NativeOutcome,
  project: string,
  checkBudget: () => void = () => {},
): LayoutResult {
  const root = realpathSync(project);
  if (!statSync(root).isDirectory()) throw new Error("project must be a directory");
  const result: LayoutResult = { findings: [], crates: 0, files: 0 };
  const report = (rule: string, file: string, message: string, line?: number) =>
    result.findings.push(finding(`module-layout.${rule}`, posix(relative(root, file)) || ".", message, line));
  const manifests: string[] = [];
  const sources: string[] = [];
  function discover(directory: string): void {
    checkBudget();
    const entries = readLayoutDirectory(directory, report);
    if (!entries) return;
    for (const entry of entries) {
      if (!admitLayoutEntry(root, directory, entry, report)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) discover(path);
      else if (entry.isFile()) {
        if (entry.name === "Cargo.toml") manifests.push(path);
        if (entry.name.endsWith(".rs")) sources.push(path);
      }
    }
  }
  discover(root);
  const configPath = join(root, DOCUMENT_NAME);
  const holdsRust = manifests.length > 0 || sources.length > 0;
  if (!holdsRust && !existsSync(configPath)) return result;
  const selection = readLayoutSelection(configPath);
  if ("message" in selection) {
    report("configuration", configPath, selection.message);
    return result;
  }
  if (selection.rust === null) {
    // Nothing to inspect, and nothing that says how it would be inspected: a project that uses no
    // Rust states no Rust layout, so holding Rust anyway is a settings defect rather than a layout one.
    if (!holdsRust) return result;
    report(
      "configuration",
      configPath,
      `this project holds Rust but ${DOCUMENT_NAME} does not name rust among its languages`,
    );
    return result;
  }
  result.mode = selection.rust.moduleLayout;
  const declarations = readProjectFacts(extractor, root, sources, checkBudget).files;
  const covered = new Set<string>();
  const crates = new Set<string>();
  for (const manifest of manifests.sort()) {
    checkBudget();
    const directory = dirname(manifest);
    const workspace = scanWorkspace(directory);
    for (const diagnostic of workspace.diagnostics)
      report("unresolved", join(directory, diagnostic.file), diagnostic.message);
    for (const crate of workspace.members) {
      const path = realpathSync(join(directory, crate.path));
      if (!within(root, path)) {
        report("unresolved", manifest, "Cargo member is outside the inspected project");
        continue;
      }
      if (crates.has(path)) continue;
      crates.add(path);
      result.crates++;
      if (crate.targets.length === 0)
        report("unresolved", join(path, "Cargo.toml"), "Cargo package has no inspectable targets");
      const inventory = inspectModules(
        declarations,
        root,
        {
          crate_name: crate.name,
          path: relative(root, path),
          targets: crate.targets,
          layer: "unknown",
          layer_source: "none",
          cqrs_side: "none",
          cqrs_source: "none",
          is_composition_root: false,
          diagnostics: [],
        },
        { includeAuxiliary: true, checkBudget, covers: coveredByScan },
      );
      for (const issue of inventory.problems) report("unresolved", join(root, issue.file), issue.reason, issue.line);
      for (const source of inventory.sources) {
        covered.add(source.path);
        if (source.root) continue;
        // A file whose declarations were not read is already reported as unresolved, and the walk
        // never established whether it has children. Judging its placement as if it had none would
        // put a second finding of a different kind on the same file.
        if (!declarations.has(source.decidedFrom)) continue;
        const moduleName = source.parts.at(-1);
        const isMod = basename(source.path) === "mod.rs";
        const useMod = result.mode === "mod-rs" && source.hasChildren;
        const correctName = useMod
          ? isMod && basename(dirname(source.path)) === moduleName
          : basename(source.path) === `${moduleName}.rs`;
        if (!correctName) {
          const parent = isMod ? dirname(dirname(source.path)) : dirname(source.path);
          const expected = useMod ? join(parent, moduleName ?? "", "mod.rs") : join(parent, `${moduleName}.rs`);
          report(
            "violation",
            source.path,
            `${result.mode} layout requires ${posix(relative(root, expected))}; move this module and update its mod/path declarations, preserving child resolution`,
          );
        }
      }
    }
  }
  for (const source of sources) {
    if (!covered.has(source))
      report(
        "unresolved",
        source,
        "Rust source is not reachable from a Cargo target; register it or remove the stale file",
      );
  }
  result.files = covered.size;
  if (result.crates === 0 && manifests.length === 0)
    report("unresolved", root, "No Cargo project found for the configured Rust module check");
  const seen = new Set<string>();
  result.findings = result.findings.filter((entry) => {
    const key = `${entry.rule_id}:${entry.file}:${entry.line ?? 0}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result;
}
