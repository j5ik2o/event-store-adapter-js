/**
 * The TypeScript packages of a project as the domain gate reads them: the `package.json` that owns
 * a file, the layer its name and placement give it, the module path a source file names below its
 * `src/` root, and what its `exports` and `imports` fields make public.
 *
 * A package is identified by its directory. Its name is the one the `package.json` states; the
 * layer conventions are applied to that name with the scope — which names only the publisher —
 * set aside, exactly as they are applied to a crate name.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { barePackageName } from "../../shared/package-name.ts";
import { isExcludedFromProjectScan } from "../../shared/project-scope.ts";
import { assignLayer, type CrateLayerAssignment } from "../../workspace/resolver.ts";

export const PACKAGE_MANIFEST = "package.json";

export interface TsPackage {
  /** The absolute package directory. */
  readonly root: string;
  /** The package directory relative to the project root, `.` for the root itself. */
  readonly path: string;
  /** The name its `package.json` states. */
  readonly name: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly assignment: CrateLayerAssignment;
}

const posix = (path: string) => path.split(sep).join("/");

/** `to` relative to `from`, with `/` separators, `.` for `from` itself. */
export function posixRelative(from: string, to: string): string {
  const rel = posix(relative(from, to));
  return rel === "" ? "." : rel;
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/** Whether a file is a TypeScript source the gate reads: `.ts` or `.tsx`, not a declaration file. */
export function isTypeScriptSource(file: string): boolean {
  return (file.endsWith(".ts") || file.endsWith(".tsx")) && !file.endsWith(".d.ts");
}

/** A test file: `*.test.ts`, `*.spec.ts`, or anything below a `__tests__` directory. */
function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file) || posix(file).split("/").includes("__tests__");
}

function readManifest(path: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * The package whose directory is `root`, or why it is none: a directory without a `package.json`,
 * or with one that states no name, declares no package the gate can name.
 */
export function readPackage(workspaceRoot: string, root: string): TsPackage | { readonly problem: string } {
  const manifestPath = join(root, PACKAGE_MANIFEST);
  if (!existsSync(manifestPath)) return { problem: `${posixRelative(workspaceRoot, manifestPath)} is not there` };
  const manifest = readManifest(manifestPath);
  if (!manifest) return { problem: `${posixRelative(workspaceRoot, manifestPath)} is not a JSON object` };
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    return { problem: `${posixRelative(workspaceRoot, manifestPath)} states no name` };
  const path = posixRelative(workspaceRoot, root);
  return {
    root,
    path,
    name: manifest.name,
    manifest,
    assignment: assignLayer(
      { name: barePackageName("typescript", manifest.name), path, targets: [], internal_dependencies: [] },
      PACKAGE_MANIFEST,
    ),
  };
}

/**
 * Every package of the workspace: each directory, the root included, whose `package.json` states a
 * name. The walk skips what no project scan counts as its content, dependencies installed under
 * `node_modules` among them, and does not follow symbolic links.
 */
export function workspacePackages(workspaceRoot: string): TsPackage[] {
  const found: TsPackage[] = [];
  const walk = (directory: string) => {
    const pkg = readPackage(workspaceRoot, directory);
    if (!("problem" in pkg)) found.push(pkg);
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && !isExcludedFromProjectScan(entry.name)) walk(join(directory, entry.name));
  };
  walk(workspaceRoot);
  return found;
}

/** The nearest directory at or above `file`'s directory, inside `workspaceRoot`, that holds a `package.json`. */
export function owningPackageRoot(workspaceRoot: string, file: string): string | undefined {
  for (let current = dirname(file); isInside(workspaceRoot, current); current = dirname(current)) {
    if (existsSync(join(current, PACKAGE_MANIFEST))) return current;
    if (current === dirname(current)) break;
  }
  return undefined;
}

/** How a file of a package takes part in the gate. */
type FileRole = "source" | "auxiliary" | "composition-root";

/** A source is a non-test TypeScript file below the package's `src/`; anything else is auxiliary. */
export function roleOf(pkg: TsPackage, file: string): FileRole {
  if (pkg.assignment.is_composition_root) return "composition-root";
  const rel = posixRelative(pkg.root, file);
  return rel.startsWith("src/") && isTypeScriptSource(rel) && !isTestFile(rel) ? "source" : "auxiliary";
}

/**
 * The module path a source names below the package root: `src/index.ts` is the root `[]`,
 * `src/a.ts` and `src/a/index.ts` are `[a]`, and `src/a/b.ts` is `[a, b]`.
 */
export function modulePathOf(pkg: TsPackage, file: string): string[] {
  const rel = posixRelative(join(pkg.root, "src"), file).replace(/\.tsx?$/, "");
  const parts = rel.split("/");
  if (parts[parts.length - 1] === "index") parts.pop();
  return parts;
}

/** Every source of the package, absolute and sorted. */
export function packageSources(pkg: TsPackage): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.isFile() && roleOf(pkg, full) === "source") out.push(full);
    }
  };
  const src = join(pkg.root, "src");
  if (existsSync(src)) walk(src);
  return out.sort((a, b) => a.localeCompare(b, "en"));
}

/** What the `exports` field of a package states, as far as the gate models it. */
type PackageExports =
  | { readonly kind: "absent" }
  | { readonly kind: "unsupported"; readonly why: string }
  | { readonly kind: "map"; readonly entries: readonly (readonly [string, unknown])[] };

/**
 * The subpath map `exports` states. A string, or an object of conditions, exports the package root
 * alone; an object of `.`-keys maps subpaths. Anything else — an array of fallbacks, keys that mix
 * subpaths and conditions — is not modelled.
 */
export function exportsOf(pkg: TsPackage): PackageExports {
  const value = pkg.manifest.exports;
  if (value === undefined) return { kind: "absent" };
  if (value === null) return { kind: "map", entries: [] };
  if (typeof value === "string") return { kind: "map", entries: [[".", value]] };
  if (Array.isArray(value) || typeof value !== "object") return { kind: "unsupported", why: "exports is not a map" };
  const keys = Object.keys(value);
  const subpaths = keys.filter((key) => key.startsWith("."));
  if (subpaths.length === 0) return { kind: "map", entries: [[".", value]] };
  if (subpaths.length !== keys.length) return { kind: "unsupported", why: "exports mixes subpaths and conditions" };
  return { kind: "map", entries: Object.entries(value as Record<string, unknown>) };
}

/** Whether `key` — a subpath, or a pattern with one `*` — matches `subpath`. */
export function matchesSubpath(key: string, subpath: string): boolean {
  const star = key.indexOf("*");
  if (star < 0) return key === subpath || (key.endsWith("/") && subpath.startsWith(key));
  if (key.indexOf("*", star + 1) >= 0) return false;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return subpath.length >= prefix.length + suffix.length && subpath.startsWith(prefix) && subpath.endsWith(suffix);
}

/** The part of a key a subpath is matched on before any `*`: the whole key when it has none. */
function keyPrefix(key: string): string {
  const star = key.indexOf("*");
  return star < 0 ? key : key.slice(0, star);
}

/**
 * Whether the map exports `subpath`. As Node resolves it, one key decides: the key equal to the
 * subpath, else the matching key with the longest part before its `*` (a key ending in `/` counts
 * whole), the longer key on a tie. A `null` target of that key withholds the subpath.
 */
export function isExported(entries: PackageExports & { kind: "map" }, subpath: string): boolean {
  const decisive = decisiveEntry(entries.entries, subpath);
  return decisive !== undefined && decisive[1] !== null;
}

/**
 * The one entry of an `exports` or `imports` map that decides `subpath`, as Node selects it: the key
 * equal to the subpath, else the matching key with the longest part before its `*`, the longer key on
 * a tie. The order the keys are written in never decides.
 */
function decisiveEntry(
  entries: readonly (readonly [string, unknown])[],
  subpath: string,
): readonly [string, unknown] | undefined {
  const matching = entries.filter(([key]) => matchesSubpath(key, subpath));
  return (
    matching.find(([key]) => key === subpath) ??
    [...matching].sort(([a], [b]) => keyPrefix(b).length - keyPrefix(a).length || b.length - a.length)[0]
  );
}

function targetStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(targetStrings);
}

/** Whether a file of a package is one of its public entries, or why that cannot be told. */
type PublicEntry =
  | { readonly kind: "entry" }
  | { readonly kind: "not-entry" }
  | { readonly kind: "undecidable"; readonly why: string };

/**
 * Whether `file` is a file the package's `exports` point to: one of its public entries. A package
 * that states no `exports`, states them in a form not modelled, or points them only at files that
 * are not its sources (a build output such as `./dist/index.js`) does not tell which source is
 * published. One whose every target is `null` publishes nothing.
 */
export function publicEntryOf(pkg: TsPackage, file: string): PublicEntry {
  const exported = exportsOf(pkg);
  if (exported.kind === "absent") return { kind: "undecidable", why: "no exports" };
  if (exported.kind === "unsupported") return { kind: "undecidable", why: exported.why };
  const targets = exported.entries.flatMap(([, target]) => targetStrings(target));
  if (targets.length === 0) return { kind: "not-entry" };
  const rel = `./${posixRelative(pkg.root, file)}`;
  if (targets.some((target) => matchesSubpath(target, rel))) return { kind: "entry" };
  const sources = packageSources(pkg).map((source) => `./${posixRelative(pkg.root, source)}`);
  if (!targets.some((target) => sources.some((source) => matchesSubpath(target, source))))
    return { kind: "undecidable", why: "exports point at no source of the package" };
  return { kind: "not-entry" };
}

/**
 * Where an `imports` specifier (`#…`) of the package leads, as an absolute path, or undefined when
 * the package maps no such specifier to a path of its own.
 */
export function importTarget(pkg: TsPackage, specifier: string): string | undefined {
  const imports = pkg.manifest.imports;
  if (imports === null || typeof imports !== "object" || Array.isArray(imports)) return undefined;
  // The key Node selects decides, so a more specific key written after a pattern still wins.
  const decisive = decisiveEntry(Object.entries(imports as Record<string, unknown>), specifier);
  if (decisive === undefined) return undefined;
  const [key, value] = decisive;
  if (typeof value !== "string" || !value.startsWith("./")) return undefined;
  const star = key.indexOf("*");
  const matched = star < 0 ? "" : specifier.slice(star, specifier.length - (key.length - star - 1));
  return resolve(pkg.root, value.replace("*", matched));
}

/** The names of the packages `package.json` depends on, in every dependency section. */
export function dependencyNames(pkg: TsPackage): string[] {
  const names = new Set<string>();
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg.manifest[section];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) names.add(name);
  }
  return [...names].sort();
}
