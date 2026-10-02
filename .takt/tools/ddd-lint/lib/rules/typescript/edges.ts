/**
 * The dependency edges of the TypeScript gates: where each module specifier of a checked source
 * leads, and what about that edge the dependency direction (g) and the cross-side rule (k) forbid.
 * The edges of one run are built once, and each rule takes the ones it reports.
 *
 * A specifier is classified in the order the project resolves it: a path, an `imports` specifier
 * (`#…`) of the package, a `paths` alias of the package's `tsconfig.json`, the name of a package
 * of the workspace with an optional subpath, and otherwise a package from outside the project. One
 * edge is one finding of (g), naming every decision that makes it one:
 *
 * - `layer-forbidden`: the layer permission table forbids the target package's layer;
 * - `external-io`: an external package on the I/O list, depended on from the domain or use-case
 *   layer — the layers the Rust gates forbid it in;
 * - `private-path`: a path into another package's directory, or a subpath its `exports` withholds;
 * - `alias`: a `paths` alias that leads into another package;
 * - `wildcard-reexport`: `export *` in a file the package's `exports` publish;
 * - `type-only` accompanies the others when the dependency is erased: it is judged all the same.
 *
 * An edge between the command side and the query side is one finding of (k) instead, type-only or
 * not; the rmu side bridges the two and is neither.
 *
 * What cannot be followed from the project's files — a path out of every package, a specifier the
 * package does not map, a package that states no `exports` or states them in a form not modelled,
 * a name more than one package of the workspace states, `export *` in a file of a package whose
 * `exports` do not tell whether that file is published, a package whose settings resolve bare
 * specifiers through `baseUrl` — is left undecided.
 */

import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { FindingInput } from "../../shared/findings.ts";
import type { TypeScriptPackageConfig } from "../../typescript/domain-facts/project.ts";
import { isAllowed } from "../../workspace/resolver.ts";
import { IO_PACKAGES, matchesIoRule } from "../lists.ts";
import {
  dependencyNames,
  exportsOf,
  importTarget,
  isExported,
  isInside,
  matchesSubpath,
  PACKAGE_MANIFEST,
  publicEntryOf,
  type TsPackage,
} from "./packages.ts";
import type { TsInspection, TsTarget } from "./types.ts";

/**
 * The packages of the project — every `package.json` of the workspace that states a name — the
 * `tsconfig.json` settings of those the root references, and the packages whose sources the facts
 * describe.
 */
export interface ProjectPackages {
  readonly workspaceRoot: string;
  readonly list: readonly TsPackage[];
  readonly configs: ReadonlyMap<string, TypeScriptPackageConfig>;
  /** The directories of the packages of the layers the gate describes whose every source was read into the facts. */
  readonly described: ReadonlySet<string>;
}

type SpecifierTarget =
  | {
      readonly kind: "package";
      readonly pkg: TsPackage;
      readonly via: "path" | "imports" | "alias" | "name";
      /** For a package reached by name, the subpath below it: `.` for the package itself. */
      readonly subpath?: string;
    }
  | { readonly kind: "builtin" }
  | { readonly kind: "external"; readonly name: string }
  | { readonly kind: "unresolved"; readonly reason: string };

const BUILTINS = new Set(builtinModules);

/** The package whose directory holds `path`, the innermost when directories nest. */
export function packageContaining(packages: ProjectPackages, path: string): TsPackage | undefined {
  return packages.list.filter((pkg) => isInside(pkg.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
}

function isPath(specifier: string): boolean {
  return specifier === "." || specifier === ".." || /^\.{1,2}\//.test(specifier) || specifier.startsWith("/");
}

/** The package name a bare specifier starts with: `@scope/name` or `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

type NamedPackage =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly pkg: TsPackage }
  | { readonly kind: "ambiguous"; readonly reason: string };

/** The package of the workspace a dependency names; two packages stating one name leave it undecided. */
function packageNamed(packages: ProjectPackages, name: string): NamedPackage {
  const named = packages.list.filter((pkg) => pkg.name === name);
  if (named.length > 1)
    return {
      kind: "ambiguous",
      reason: `${named.map((pkg) => pkg.path).join(" and ")} are all named ${name}`,
    };
  return named.length === 1 ? { kind: "one", pkg: named[0] } : { kind: "none" };
}

function reached(packages: ProjectPackages, path: string, via: "path" | "imports", what: string): SpecifierTarget {
  const pkg = packageContaining(packages, path);
  return pkg ? { kind: "package", pkg, via } : { kind: "unresolved", reason: `${what} leads out of every package` };
}

/** The `paths` entry a specifier matches: an exact pattern first, else the longest prefix before `*`. */
function aliasFor(config: TypeScriptPackageConfig, specifier: string): { targets: string[] } | undefined {
  const exact = config.aliases.find((alias) => alias.pattern === specifier);
  if (exact) return { targets: [...exact.targets] };
  const wildcard = config.aliases
    .filter((alias) => alias.pattern.includes("*") && matchesSubpath(alias.pattern, specifier))
    .sort((a, b) => b.pattern.indexOf("*") - a.pattern.indexOf("*"))[0];
  if (!wildcard) return undefined;
  const star = wildcard.pattern.indexOf("*");
  const matched = specifier.slice(star, specifier.length - (wildcard.pattern.length - star - 1));
  return { targets: wildcard.targets.map((target) => target.replace("*", matched)) };
}

/** Where `specifier`, written in `file` of `from`, leads. */
export function resolveSpecifier(
  packages: ProjectPackages,
  from: TsPackage,
  file: string,
  specifier: string,
): SpecifierTarget {
  if (isPath(specifier)) return reached(packages, resolve(dirname(file), specifier), "path", `"${specifier}"`);
  if (specifier.startsWith("#")) {
    const target = importTarget(from, specifier);
    if (!target) return { kind: "unresolved", reason: `"${specifier}" is not mapped by the imports of ${from.name}` };
    return reached(packages, target, "imports", `"${specifier}"`);
  }
  const config = packages.configs.get(from.root);
  if (config?.base_url) return { kind: "unresolved", reason: `${from.name} resolves bare specifiers through baseUrl` };
  const alias = config ? aliasFor(config, specifier) : undefined;
  if (alias) {
    const owners = new Set(alias.targets.map((target) => packageContaining(packages, target)));
    const [owner] = owners;
    if (owners.size !== 1 || !owner)
      return { kind: "unresolved", reason: `the alias "${specifier}" does not lead into exactly one package` };
    return { kind: "package", pkg: owner, via: "alias" };
  }
  const name = packageNameOf(specifier);
  const named = packageNamed(packages, name);
  if (named.kind === "ambiguous") return { kind: "unresolved", reason: named.reason };
  if (named.kind === "one")
    return {
      kind: "package",
      pkg: named.pkg,
      via: "name",
      subpath: specifier === name ? "." : `./${specifier.slice(name.length + 1)}`,
    };
  if (specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0])) return { kind: "builtin" };
  return { kind: "external", name };
}

/** One dependency a checked source spells: an import, or a re-export naming a module. */
interface Dependency {
  readonly specifier: string;
  readonly line: number;
  readonly type_only: boolean;
  readonly wildcard: boolean;
}

function dependenciesOf(inspection: TsInspection, file: string): Dependency[] {
  const facts = inspection.facts.files.get(file);
  if (!facts) throw new Error(`the TypeScript facts carry no record for ${file}`);
  return [
    ...facts.imports.map((entry) => ({
      specifier: entry.specifier,
      line: entry.line,
      type_only: entry.type_only,
      wildcard: false,
    })),
    ...facts.exports.flatMap((entry) =>
      entry.specifier === undefined
        ? []
        : [
            {
              specifier: entry.specifier,
              line: entry.line,
              type_only: entry.type_only,
              wildcard: entry.kind === "all" || entry.kind === "namespace",
            },
          ],
    ),
  ];
}

/** What forbids a dependency on another package of the project, besides its layer. */
function accessDecisions(
  inspection: TsInspection,
  target: SpecifierTarget & { kind: "package" },
  where: string,
  line: number,
): string[] {
  if (target.via === "path" || target.via === "imports") return ["private-path"];
  if (target.via === "alias") return ["alias"];
  const exported = exportsOf(target.pkg);
  if (exported.kind === "absent") {
    inspection.undecided.add(where, line, `dependency on ${target.pkg.name}, which states no exports`);
    return [];
  }
  if (exported.kind === "unsupported") {
    inspection.undecided.add(where, line, `dependency on ${target.pkg.name}: ${exported.why}`);
    return [];
  }
  return isExported(exported, target.subpath ?? ".") ? [] : ["private-path"];
}

/**
 * One dependency of a checked source or of its package's `package.json`, with what (g) forbids about
 * it and whether (k) does.
 */
export interface TsEdge {
  readonly from: TsPackage;
  /** The package it leads to, by the name it states, or the external package's name. */
  readonly to: string;
  /** The specifier as written, quoted, or `package.json`. */
  readonly via: string;
  readonly file: string;
  /** Absent for a `package.json` dependency, which has no line of its own. */
  readonly line?: number;
  /** The decisions of (g), `type-only` included when the dependency is erased. */
  readonly decisions: readonly string[];
  readonly cross_side: boolean;
  readonly type_only: boolean;
}

const VIOLATIONS = new Set(["layer-forbidden", "external-io", "private-path", "alias", "wildcard-reexport"]);

/**
 * The edges of every checked source and of the `package.json` of each package holding one. A
 * `package.json` dependency an import of the same package already stands for is not a second edge.
 */
export function buildEdges(inspection: TsInspection): TsEdge[] {
  const edges: TsEdge[] = [];
  /** `<package dir> -> <target>` for every edge an import already stands for. */
  const imported = new Set<string>();
  for (const target of inspection.targets) edges.push(...fileEdges(inspection, target, imported));
  const fromPackages = [...new Map(inspection.targets.map((target) => [target.pkg.root, target.pkg])).values()];
  for (const from of fromPackages) {
    const manifest = from.path === "." ? PACKAGE_MANIFEST : `${from.path}/${PACKAGE_MANIFEST}`;
    for (const name of dependencyNames(from)) {
      const named = packageNamed(inspection.packages, name);
      if (named.kind === "ambiguous") {
        inspection.undecided.add(manifest, undefined, `dependency "${name}": ${named.reason}`);
        continue;
      }
      const to = named.kind === "one" ? named.pkg : undefined;
      if (to?.root === from.root || imported.has(`${from.root} -> ${to ? to.root : name}`)) continue;
      const reason = to ? isAllowed(from.assignment, to.assignment).reason : undefined;
      edges.push({
        from,
        to: name,
        via: PACKAGE_MANIFEST,
        file: manifest,
        decisions: to ? (reason === "layer-forbidden" ? ["layer-forbidden"] : []) : ioDecisions(from, name),
        cross_side: reason === "cross-side",
        type_only: false,
      });
    }
  }
  return edges;
}

/** An external I/O package is forbidden where the edge starts in the domain or the use-case layer. */
function ioDecisions(from: TsPackage, name: string): string[] {
  const layer = from.assignment.layer;
  return (layer === "domain" || layer === "use-case") && matchesIoRule(name, IO_PACKAGES) ? ["external-io"] : [];
}

function fileEdges(inspection: TsInspection, target: TsTarget, imported: Set<string>): TsEdge[] {
  const edges: TsEdge[] = [];
  const from = target.pkg;
  const absolute = join(inspection.packages.workspaceRoot, target.file);
  for (const dependency of dependenciesOf(inspection, target.file)) {
    const resolved = resolveSpecifier(inspection.packages, from, absolute, dependency.specifier);
    const via = `"${dependency.specifier}"`;
    let to = from.name;
    let crossSide = false;
    const decisions: string[] = [];
    if (resolved.kind === "unresolved") {
      inspection.undecided.add(target.file, dependency.line, `dependency ${via}: ${resolved.reason}`);
      continue;
    }
    if (resolved.kind === "external") {
      to = resolved.name;
      imported.add(`${from.root} -> ${resolved.name}`);
      decisions.push(...ioDecisions(from, resolved.name));
    } else if (resolved.kind === "package" && resolved.pkg.root !== from.root) {
      to = resolved.pkg.name;
      imported.add(`${from.root} -> ${resolved.pkg.root}`);
      const reason = isAllowed(from.assignment, resolved.pkg.assignment).reason;
      if (reason === "layer-forbidden") decisions.push("layer-forbidden");
      crossSide = reason === "cross-side";
      decisions.push(...accessDecisions(inspection, resolved, target.file, dependency.line));
    }
    if (dependency.wildcard) {
      const entry = publicEntryOf(from, absolute);
      if (entry.kind === "undecidable") {
        inspection.undecided.add(
          target.file,
          dependency.line,
          `export * ${via}: whether ${from.name} publishes this file is unknown (${entry.why})`,
        );
        continue;
      }
      if (entry.kind === "entry") decisions.push("wildcard-reexport");
    }
    if (dependency.type_only) decisions.push("type-only");
    edges.push({
      from,
      to,
      via,
      file: target.file,
      line: dependency.line,
      decisions,
      cross_side: crossSide,
      type_only: dependency.type_only,
    });
  }
  return edges;
}

/** The findings of rule (g): each edge a decision of the dependency direction forbids. */
export function ruleG(edges: readonly TsEdge[]): FindingInput[] {
  return edges
    .filter((edge) => edge.decisions.some((decision) => VIOLATIONS.has(decision)))
    .map((edge) => ({
      rule_id: "g",
      file: edge.file,
      message: `dependency direction ${edge.from.name} -> ${edge.to} via ${edge.via} (${edge.decisions.join(", ")})`,
      ...(edge.line === undefined ? {} : { line: edge.line }),
    }));
}

/** The findings of rule (k): each edge between the command side and the query side. */
export function ruleK(edges: readonly TsEdge[]): FindingInput[] {
  return edges
    .filter((edge) => edge.cross_side)
    .map((edge) => ({
      rule_id: "k",
      file: edge.file,
      message: `cross-side reference ${edge.from.name} -> ${edge.to} via ${edge.via}${edge.type_only ? " (type-only)" : ""}`,
      ...(edge.line === undefined ? {} : { line: edge.line }),
    }));
}
