import type { Dirent } from "node:fs";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RustFileFacts } from "../rust/domain-facts/index.ts";
import type { CrateLayerAssignment } from "../workspace/resolver.ts";

export interface DomainModule {
  parts: string[];
  physical: string[];
  file: string;
  line: number;
}
/**
 * One file the walk opened.
 *
 * `file` is the path the walk reached it by, which is the one a finding sends a reader to and the
 * one a checked file names. `decidedFrom` is the path of the file the walk actually read, which is the one
 * the extractor was asked about; the two differ when a declaration names a symbolic link. A caller
 * that looks the file up among the native facts uses `decidedFrom`, because that is the key the
 * batch was built under.
 */
interface ModuleSource {
  file: string;
  decidedFrom: string;
  path: string;
  parts: string[];
  root: boolean;
  hasChildren: boolean;
}
export interface ModuleInventory {
  modules: DomainModule[];
  sources: ModuleSource[];
  files: Set<string>;
  problems: { file: string; line: number; reason: string }[];
}

/**
 * What the module walk reads about one file. The walk decides which file to open next from the
 * declarations of the one it is on, so the answer has to already cover every file it could reach.
 */
export type ModuleDeclarations = ReadonlyMap<string, RustFileFacts>;

const AUXILIARY = new Set(["tests", "benches", "examples", "vendor", "target"]);
const posix = (path: string) => path.split(sep).join("/");
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Whether `rustSourcesUnder` enumerates this file, which is the rule its batch is gathered by.
 *
 * A `#[path]` names its target verbatim and Rust accepts any file name there, and a `.rs` name can
 * itself be a link onto a file named otherwise, so the walk can reach a name this rule leaves out
 * either way. Callers that batch by this rule hand it to `inspectModules` as `covers`, which asks
 * it about the file the walk would read and so keeps the walk from opening one the extractor was
 * never asked about.
 */
export function isRustSource(file: string): boolean {
  return file.endsWith(".rs");
}

/**
 * Every Rust source under `directory` the module walk could open, as `workspace`-relative paths.
 *
 * The walk cannot say in advance which files it will reach, and the extractor answers one batch, so
 * the batch covers this superset instead: the walk only ever follows a declaration to a file under
 * the crate it started in, and a file it never reaches simply goes unused.
 */
export function rustSourcesUnder(workspace: string, directory: string): string[] {
  const workspaceRoot = realpathSync(workspace);
  const root = realpathSync(directory);
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // A directory that cannot be listed hides the files under it. The walk reports that for the
      // one file a declaration names, which is where it is a defect of this crate rather than of
      // an unrelated tree beside it.
      return;
    }
    for (const entry of entries) {
      // A symbolic link is followed only where a module declaration names it, and the walk reads
      // the real file it resolves to — which this listing reaches on its own.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (AUXILIARY.has(entry.name)) continue;
        walk(join(current, entry.name));
      } else if (entry.isFile() && isRustSource(entry.name)) {
        found.push(posix(relative(workspaceRoot, join(current, entry.name))));
      }
    }
  };
  walk(root);
  return found;
}

/** Follow Rust mod declarations from this crate's lib/bin roots, never from unrelated crates. */
export function inspectModules(
  declarations: ModuleDeclarations,
  workspace: string,
  crate: CrateLayerAssignment,
  options: {
    includeAuxiliary?: boolean;
    checkBudget?: () => void;
    /**
     * Whether the batch behind `declarations` covers this `workspace`-relative file. The file asked
     * about is the one the walk would read and look up among `declarations` — a link is resolved
     * first, so the answer is about the same key the batch was built under. A caller that gathered
     * its batch over a narrower set than this walk can reach answers `false` outside it, so a
     * declaration pointing there is reported where it is written rather than followed to a file the
     * extractor was never asked about — which the walk would otherwise read as unparsable.
     *
     * Required: every caller states its own batch rule, because the only default this could carry
     * is "everything is covered", which is the walk this check exists to stop.
     */
    covers: (file: string) => boolean;
  },
): ModuleInventory {
  const workspaceRoot = realpathSync(workspace);
  const root = realpathSync(join(workspace, crate.path));
  const inventory: ModuleInventory = { modules: [], sources: [], files: new Set(), problems: [] };
  const location = (path: string) => posix(relative(workspaceRoot, path));
  const physical = (path: string) =>
    posix(relative(root, path))
      .split("/")
      .filter((part) => part !== "src")
      .map((part) => part.replace(/\.rs$/, ""))
      .filter((part) => !["lib", "main", "mod"].includes(part));
  const problem = (file: string, line: number, reason: string) =>
    inventory.problems.push({ file: location(file), line, reason });
  // The batch is keyed by the file the walk reads rather than by the name it reached that file by,
  // so the question is asked about the resolved file — otherwise a link named `.rs` onto a file the
  // batch leaves out passes this check and is then reported as one the extractor could not read.
  // A path that resolves to nothing is left to `visit`, which owns saying why a module file could
  // not be read; asking about an unresolvable name here would answer about a file that is not there.
  const covers = (path: string) => {
    let actual: string;
    try {
      actual = realpathSync(path);
    } catch {
      return true;
    }
    return options.covers(location(actual));
  };

  function visit(path: string, namespace: string[], stack: Set<string>, ownsDirectory = false, isRoot = false): void {
    options.checkBudget?.();
    let actual: string;
    try {
      actual = realpathSync(path);
      if (!inside(root, actual) || !statSync(actual).isFile())
        throw new Error("module is outside its crate or is not a file");
      if (stack.has(actual)) throw new Error("cyclic module path");
    } catch (error) {
      problem(path, 1, error instanceof Error ? error.message : String(error));
      return;
    }
    const segments = posix(relative(root, actual)).split("/");
    if (!options.includeAuxiliary && segments.some((part) => AUXILIARY.has(part))) return;
    inventory.files.add(location(path));
    inventory.files.add(location(actual));
    const facts = declarations.get(location(actual));
    if (!facts) {
      // The declarations a module file carries are what decides where the walk goes next. Without
      // them this file is reported as unreadable, and never as one that declares no child.
      inventory.sources.push({
        file: location(path),
        decidedFrom: location(actual),
        path: actual,
        parts: namespace,
        root: isRoot,
        hasChildren: false,
      });
      inventory.modules.push({ parts: namespace, physical: physical(actual), file: location(path), line: 1 });
      problem(path, 1, "Rust module could not be parsed");
      return;
    }
    if (facts.auxiliary && !options.includeAuxiliary) return;
    const declared = facts.modules.filter((entry) => options.includeAuxiliary || !entry.auxiliary);
    inventory.sources.push({
      file: location(path),
      decidedFrom: location(actual),
      path: actual,
      parts: namespace,
      root: isRoot,
      hasChildren: declared.length > 0,
    });
    inventory.modules.push({ parts: namespace, physical: physical(actual), file: location(path), line: 1 });
    for (const macro of facts.itemMacros) {
      if (!options.includeAuxiliary && macro.auxiliary) continue;
      problem(path, macro.line, "item macro may declare modules; expansion is not available");
    }
    const nextStack = new Set(stack).add(actual);
    const childBase =
      ownsDirectory || basename(actual) === "mod.rs" ? dirname(actual) : join(dirname(actual), basename(actual, ".rs"));
    const bases = new Map<string, string>([["", childBase]]);
    for (const mod of declared) {
      const scope = mod.module.join("::");
      const base = bases.get(scope);
      if (!base || mod.local || mod.unresolved_path) {
        problem(path, mod.line, "module scope or path attribute cannot be resolved");
        continue;
      }
      const parts = [...namespace, ...mod.module, mod.name];
      let destination: string;
      if (mod.path !== undefined) destination = resolve(scope === "" ? dirname(actual) : base, mod.path);
      else destination = join(base, mod.name);
      if (!inside(root, destination)) {
        problem(path, mod.line, "module path escapes the crate");
        continue;
      }
      inventory.modules.push({
        parts,
        physical: physical(destination),
        file: location(path),
        line: mod.line,
      });
      if (mod.inline) {
        bases.set([...mod.module, mod.name].join("::"), destination);
        continue;
      }
      const candidates = mod.path !== undefined ? [destination] : [`${destination}.rs`, join(destination, "mod.rs")];
      const existing = candidates.filter((candidate) => existsSync(candidate));
      if (existing.length !== 1) {
        problem(path, mod.line, "external module needs exactly one source file");
        continue;
      }
      if (!covers(existing[0])) {
        problem(path, mod.line, `module ${mod.name} resolves to a file this inspection does not cover`);
        continue;
      }
      visit(existing[0], parts, nextStack, mod.path !== undefined);
    }
  }
  for (const target of crate.targets) {
    if (!options.includeAuxiliary && target.kind !== "lib" && target.kind !== "bin") continue;
    const source = join(root, target.src_path);
    // A target root is reached the same way a declared module is, so the same batch has to cover it.
    if (!covers(source)) {
      problem(
        join(root, "Cargo.toml"),
        1,
        `Cargo target ${target.name} resolves to a file this inspection does not cover`,
      );
      continue;
    }
    visit(source, [], new Set(), true, true);
  }
  return inventory;
}
