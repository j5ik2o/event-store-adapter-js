import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { SPELLINGS } from "../aggregate-mapping/language.ts";
import { DOCUMENT_NAME, type TypeScriptModuleLayout } from "../project-settings/contract.ts";
import { finding } from "../project/context.ts";
import type { FindingInput } from "../shared/findings.ts";
import { readLayoutSelection } from "./settings.ts";
import { admitLayoutEntry, readLayoutDirectory } from "./walk.ts";

export interface TypeScriptLayoutResult {
  findings: FindingInput[];
  /** Packages whose `src` source root was inspected. */
  packages: number;
  /** Module files placed inside those source roots. */
  files: number;
  mode?: TypeScriptModuleLayout;
}

/** The files and subdirectories of one directory the walk listed, both already filtered by the project scan. */
interface Listing {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

const PACKAGE_MANIFEST = "package.json";
const COMPILER_SETTINGS = "tsconfig.json";
const SOURCE_ROOT = "src";
/** The file a module directory holds for its own module under `index-file`, and a package's entry. */
const INDEX_FILE = "index.ts";
/** Every file the TypeScript compiler reads as source; only `<segment>.ts` among them can be placed. */
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const MODULE_FILE_EXTENSION = ".ts";

const posix = (path: string) => path.split(sep).join("/");
const isTypeScriptSource = (name: string) => TYPESCRIPT_SOURCE.test(name);
const isModuleSegment = SPELLINGS.typescript.isModuleSegment;
/** True when `path` is `root` itself or lies beneath it. */
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/**
 * Whole-project check of where each TypeScript module's file sits.
 *
 * A TypeScript module is its file, and whether a module has children is decided by its directory:
 * `src/<m>/` holding TypeScript sources makes `<m>` a parent. The check therefore reads the tree only
 * — no declarations, no imports, and no layout inferred from the files already present. Only `src`
 * directly under a package root (a directory holding `package.json`) is a source root.
 */
export function checkTypeScriptModuleLayout(
  project: string,
  checkBudget: () => void = () => {},
): TypeScriptLayoutResult {
  const root = realpathSync(project);
  if (!statSync(root).isDirectory()) throw new Error("project must be a directory");
  const result: TypeScriptLayoutResult = { findings: [], packages: 0, files: 0 };
  const rel = (path: string) => posix(relative(root, path)) || ".";
  const report = (rule: string, path: string, message: string) =>
    result.findings.push(finding(`module-layout.${rule}`, rel(path), message));

  const listings = new Map<string, Listing>();
  const packageRoots: string[] = [];
  let holdsTypeScript = false;
  function discover(directory: string): void {
    checkBudget();
    const entries = readLayoutDirectory(directory, report);
    if (!entries) return;
    const files: string[] = [];
    const directories: string[] = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!admitLayoutEntry(root, directory, entry, report)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entry.name);
        discover(path);
      } else if (entry.isFile()) {
        files.push(entry.name);
        if (entry.name === PACKAGE_MANIFEST) packageRoots.push(directory);
        if (entry.name === COMPILER_SETTINGS || isTypeScriptSource(entry.name)) holdsTypeScript = true;
      }
    }
    listings.set(directory, { files, directories });
  }
  discover(root);

  const configPath = join(root, DOCUMENT_NAME);
  // A project that neither holds TypeScript nor states settings has nothing this check could inspect.
  if (!holdsTypeScript && !existsSync(configPath)) return { findings: [], packages: 0, files: 0 };
  const selection = readLayoutSelection(configPath);
  if ("message" in selection) {
    report("configuration", configPath, selection.message);
    return result;
  }
  if (selection.typescript === null) {
    // A project that uses no TypeScript states no TypeScript layout; holding TypeScript anyway is a
    // settings defect rather than a layout one.
    if (!holdsTypeScript) return { findings: [], packages: 0, files: 0 };
    report(
      "configuration",
      configPath,
      `this project holds TypeScript but ${DOCUMENT_NAME} does not name typescript among its languages`,
    );
    return result;
  }
  const mode = selection.typescript.moduleLayout;
  result.mode = mode;

  const sourceRootOf = (directory: string) =>
    listings.get(directory)?.directories.includes(SOURCE_ROOT) ? join(directory, SOURCE_ROOT) : undefined;
  const sourceRoots = packageRoots.map(sourceRootOf).filter((path): path is string => path !== undefined);
  // A package inside another package's source root belongs to neither: which package owns its modules
  // cannot be decided, so neither tree is judged over it.
  const nested = new Set(packageRoots.filter((directory) => sourceRoots.some((source) => within(source, directory))));
  for (const directory of [...nested].sort())
    report(
      "unresolved",
      join(directory, PACKAGE_MANIFEST),
      "package is inside another package's src directory; which package owns its modules cannot be decided",
    );

  /** TypeScript sources beneath `directory`, and whether any directory there could not be listed. */
  const contents = new Map<string, { sources: number; blocked: boolean }>();
  function inspect(directory: string): { sources: number; blocked: boolean } {
    const known = contents.get(directory);
    if (known) return known;
    const listing = listings.get(directory);
    // A directory the walk could not list has no listing, and is already reported.
    const found = { sources: 0, blocked: listing === undefined };
    if (listing) {
      found.sources = listing.files.filter(isTypeScriptSource).length;
      for (const name of listing.directories) {
        const path = join(directory, name);
        if (nested.has(path)) continue;
        const inner = inspect(path);
        found.sources += inner.sources;
        found.blocked ||= inner.blocked;
      }
    }
    contents.set(directory, found);
    return found;
  }

  function judge(directory: string, isSourceRoot: boolean): void {
    checkBudget();
    const listing = listings.get(directory);
    if (!listing) return;
    for (const name of listing.files) {
      if (!isTypeScriptSource(name)) continue;
      // The package entry is not a module the layout places; a module directory's own index file is
      // judged with that directory below.
      if (name === INDEX_FILE) {
        if (!isSourceRoot) result.files++;
        continue;
      }
      const segment = name.endsWith(MODULE_FILE_EXTENSION) ? name.slice(0, -MODULE_FILE_EXTENSION.length) : "";
      if (isModuleSegment(segment)) {
        result.files++;
        continue;
      }
      report(
        "unresolved",
        join(directory, name),
        "this TypeScript source cannot be placed as a module: a module file is named <module>.ts, or index.ts inside its module directory",
      );
    }
    for (const name of listing.directories) {
      const moduleDirectory = join(directory, name);
      if (nested.has(moduleDirectory)) continue;
      const { sources, blocked } = inspect(moduleDirectory);
      if (blocked) {
        // Whether this module has children is what could not be read; the unreadable directory is
        // already reported, so its placement is not judged as if the listing were complete.
        judge(moduleDirectory, false);
        continue;
      }
      // A directory holding no TypeScript (assets, data) is not a module directory.
      if (sources === 0) continue;
      if (!isModuleSegment(name)) {
        report("unresolved", moduleDirectory, "this directory name cannot be a TypeScript module name");
        continue;
      }
      const namedFile = join(directory, `${name}${MODULE_FILE_EXTENSION}`);
      const indexFile = join(moduleDirectory, INDEX_FILE);
      const hasNamed = listing.files.includes(`${name}${MODULE_FILE_EXTENSION}`);
      const hasIndex = listings.get(moduleDirectory)?.files.includes(INDEX_FILE) ?? false;
      const hasChildren = sources - (hasIndex ? 1 : 0) > 0;
      const expected = mode === "index-file" && hasChildren ? indexFile : namedFile;
      if (hasNamed && hasIndex) {
        const message = `module ${name} is placed in both ${rel(namedFile)} and ${rel(indexFile)}; keep only ${rel(expected)}`;
        report("unresolved", namedFile, message);
        report("unresolved", indexFile, message);
      } else if (!hasNamed && !hasIndex) {
        report(
          "unresolved",
          moduleDirectory,
          `module directory has no module file; ${mode} layout places it at ${rel(expected)}`,
        );
      } else {
        const actual = hasNamed ? namedFile : indexFile;
        if (actual !== expected)
          report(
            "violation",
            actual,
            `${mode} layout requires ${rel(expected)}${hasChildren ? "" : " for a module without children"}; move this module file and update the imports that name it`,
          );
      }
      judge(moduleDirectory, false);
    }
  }

  for (const directory of [...packageRoots].sort()) {
    if (nested.has(directory)) continue;
    const source = sourceRootOf(directory);
    if (!source || nested.has(source)) continue;
    result.packages++;
    judge(source, true);
  }
  if (result.packages === 0)
    report(
      "unresolved",
      root,
      "No TypeScript package with a src directory found for the configured TypeScript module check",
    );
  const seen = new Set<string>();
  result.findings = result.findings.filter((entry) => {
    const key = `${entry.rule_id}:${entry.file}:${entry.line ?? 0}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result;
}
