/**
 * WorkspaceLayerResolver — the Cargo-workspace facts.
 *
 * It reads only Cargo.toml files, applies the layer / CQRS /
 * composition-root conventions, and returns facts plus the mechanical
 * diagnostics it is allowed to raise (layer unknown / conflict / mixed targets
 * / unowned / cqrs conflict / query-domain / workspace unreadable / no members).
 * It never decides rule violations (a)–(n); those belong to the rules.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve as resolvePath } from "node:path";

export type CargoTargetKind = "lib" | "bin" | "test" | "example" | "bench" | "build-script";
export type Layer =
  | "domain"
  | "use-case"
  | "interface-adapter"
  | "infrastructure"
  | "rmu"
  | "composition-root"
  | "unknown";
export type LayerSource = "suffix" | "directory" | "both" | "marker" | "none";
export type CqrsSide = "command" | "query" | "rmu" | "none";
export type CqrsSource = "segment" | "directory" | "both" | "none";
export type EffectiveLayer = Layer | "auxiliary";
export type DiagnosticCode =
  | "layer.unknown"
  | "layer.conflict"
  | "layer.mixed-targets"
  | "layer.unowned"
  | "cqrs.conflict"
  | "cqrs.query-domain"
  | "workspace.unreadable"
  | "workspace.no-members";

export interface CargoTarget {
  kind: CargoTargetKind;
  name: string;
  src_path: string;
}

export interface CrateManifest {
  name: string;
  path: string;
  targets: CargoTarget[];
  internal_dependencies: string[];
}

export interface LayerDiagnostic {
  code: DiagnosticCode;
  severity: "blocking" | "advisory";
  crate_name?: string;
  file: string;
  message: string;
}

export interface CargoWorkspace {
  root_path: string;
  members: CrateManifest[];
  diagnostics: LayerDiagnostic[];
}

export interface CrateLayerAssignment {
  crate_name: string;
  path: string;
  layer: Layer;
  layer_source: LayerSource;
  cqrs_side: CqrsSide;
  cqrs_source: CqrsSource;
  is_composition_root: boolean;
  targets: CargoTarget[];
  diagnostics: LayerDiagnostic[];
}

export interface FileClassification {
  file: string;
  crate_name?: string;
  target_kind: CargoTargetKind | "unknown";
  role: "crate-source" | "composition-root" | "auxiliary" | "unowned";
  effective_layer: EffectiveLayer;
  cqrs_side: CqrsSide;
}

export interface DependencyPermission {
  from_layer: Exclude<Layer, "unknown">;
  to_layer: Exclude<Layer, "unknown">;
  allowed: boolean;
  cross_side_allowed: boolean;
}

const LAYER_SUFFIXES: readonly [string, Exclude<Layer, "unknown">][] = [
  ["-interface-adapter", "interface-adapter"],
  ["-infrastructure", "infrastructure"],
  ["-use-case", "use-case"],
  ["-domain", "domain"],
];
const LAYERS = ["domain", "use-case", "interface-adapter", "infrastructure"] as const;
const CQRS_SEGMENTS = ["command", "query", "rmu"] as const;

function blocking(code: DiagnosticCode, file: string, message: string, crateName?: string): LayerDiagnostic {
  return { code, severity: "blocking", file, message, ...(crateName ? { crate_name: crateName } : {}) };
}

function posixRel(from: string, to: string): string {
  const rel = relative(from, to).split("\\").join("/");
  return rel === "" ? "." : rel;
}

function readToml(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => asRecord(v) !== undefined) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Expand a Cargo member glob (`crates/*`, `packages/**`) under root. */
function expandGlob(root: string, pattern: string): string[] {
  const parts = pattern.split("/").filter((p) => p.length > 0);
  let candidates: string[] = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const base of candidates) {
      if (part === "**") {
        next.push(base);
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(join(base, entry.name));
        }
        continue;
      }
      if (part.includes("*")) {
        const regex = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && regex.test(entry.name)) next.push(join(base, entry.name));
        }
        continue;
      }
      const exact = join(base, part);
      if (existsSync(exact)) next.push(exact);
    }
    candidates = next;
  }
  return candidates;
}

function detectAutoTargets(crateDir: string, pkg: Record<string, unknown>): CargoTarget[] {
  const targets: CargoTarget[] = [];
  const has = (rel: string) => existsSync(join(crateDir, rel));
  const flag = (key: string) => pkg[key] !== false;
  if (flag("autolib") && has("src/lib.rs"))
    targets.push({ kind: "lib", name: String(pkg.name), src_path: "src/lib.rs" });
  if (flag("autobins")) {
    if (has("src/main.rs")) targets.push({ kind: "bin", name: String(pkg.name), src_path: "src/main.rs" });
    const binDir = join(crateDir, "src/bin");
    if (existsSync(binDir)) {
      for (const entry of readdirSync(binDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".rs")) {
          targets.push({ kind: "bin", name: entry.name.replace(/\.rs$/, ""), src_path: `src/bin/${entry.name}` });
        } else if (entry.isDirectory() && existsSync(join(binDir, entry.name, "main.rs"))) {
          targets.push({ kind: "bin", name: entry.name, src_path: `src/bin/${entry.name}/main.rs` });
        }
      }
    }
  }
  const autoDir = (dir: string, kind: CargoTargetKind, flagKey: string) => {
    if (!flag(flagKey)) return;
    const full = join(crateDir, dir);
    if (!existsSync(full)) return;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".rs")) {
        targets.push({ kind, name: entry.name.replace(/\.rs$/, ""), src_path: `${dir}/${entry.name}` });
      } else if (entry.isDirectory() && existsSync(join(full, entry.name, "main.rs"))) {
        targets.push({ kind, name: entry.name, src_path: `${dir}/${entry.name}/main.rs` });
      }
    }
  };
  autoDir("tests", "test", "autotests");
  autoDir("examples", "example", "autoexamples");
  autoDir("benches", "bench", "autobenches");
  if (pkg.build !== false && has("build.rs"))
    targets.push({ kind: "build-script", name: "build-script", src_path: "build.rs" });
  return targets;
}

function explicitTargets(pkg: Record<string, unknown>, raw: Record<string, unknown>): CargoTarget[] {
  const targets: CargoTarget[] = [];
  const name = String(pkg.name);
  const lib = asRecord(raw.lib);
  if (lib) {
    targets.push({ kind: "lib", name: asString(lib.name) ?? name, src_path: asString(lib.path) ?? "src/lib.rs" });
  }
  const tables: readonly [string, CargoTargetKind, string][] = [
    ["bin", "bin", "src/main.rs"],
    ["test", "test", "tests"],
    ["example", "example", "examples"],
    ["bench", "bench", "benches"],
  ];
  for (const [key, kind, fallback] of tables) {
    for (const entry of asRecordArray(raw[key])) {
      targets.push({
        kind,
        name: asString(entry.name) ?? name,
        src_path: asString(entry.path) ?? fallback,
      });
    }
  }
  if (typeof pkg.build === "string") {
    targets.push({ kind: "build-script", name: "build-script", src_path: pkg.build });
  }
  return targets;
}

function dedupeTargets(targets: CargoTarget[]): CargoTarget[] {
  const seen = new Set<string>();
  const out: CargoTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.src_path)) continue;
    seen.add(target.src_path);
    out.push(target);
  }
  return out;
}

function dependencyNames(
  crateDir: string,
  raw: Record<string, unknown>,
  memberNames: Set<string>,
  memberDirToName: Map<string, string>,
): string[] {
  const names = new Set<string>();
  const workspaceDeps = asRecord(asRecord(raw.workspace)?.dependencies) ?? {};
  for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    const deps = asRecord(raw[section]);
    if (!deps) continue;
    for (const [depName, value] of Object.entries(deps)) {
      const spec = asRecord(value);
      if (spec?.path !== undefined && typeof spec.path === "string") {
        const memberName = memberDirToName.get(resolvePath(crateDir, spec.path));
        if (memberName) names.add(memberName);
        continue;
      }
      if (spec?.workspace === true) {
        const resolved = asRecord(workspaceDeps[depName]);
        if (memberNames.has(depName)) {
          names.add(depName);
        } else if (resolved?.path !== undefined && typeof resolved.path === "string") continue;
        continue;
      }
      if (memberNames.has(depName)) names.add(depName);
    }
  }
  return [...names].sort();
}

export function scanWorkspace(rootPath: string): CargoWorkspace {
  const diagnostics: LayerDiagnostic[] = [];
  const rootToml = readToml(join(rootPath, "Cargo.toml"));
  if (!rootToml) {
    return {
      root_path: rootPath,
      members: [],
      diagnostics: [blocking("workspace.unreadable", "Cargo.toml", "root Cargo.toml is missing or unreadable")],
    };
  }

  const workspace = asRecord(rootToml.workspace);
  const rootPkg = asRecord(rootToml.package);
  const memberDirs: string[] = [];

  if (workspace) {
    const members = Array.isArray(workspace.members)
      ? workspace.members.filter((m): m is string => typeof m === "string")
      : [];
    const excludes = Array.isArray(workspace.exclude)
      ? workspace.exclude.filter((m): m is string => typeof m === "string")
      : [];
    const excluded = new Set(
      excludes.flatMap((pattern) => expandGlob(rootPath, pattern)).map((dir) => posixRel(rootPath, dir)),
    );
    const resolved = new Set<string>();
    for (const pattern of members) {
      for (const dir of expandGlob(rootPath, pattern)) {
        const rel = posixRel(rootPath, dir);
        if (!excluded.has(rel) && existsSync(join(dir, "Cargo.toml"))) resolved.add(rel);
      }
    }
    memberDirs.push(...[...resolved].sort());
    if (rootPkg && !memberDirs.includes(".")) memberDirs.push(".");
    if (memberDirs.length === 0) {
      diagnostics.push(blocking("workspace.no-members", "Cargo.toml", "no workspace members resolved"));
    }
  } else if (rootPkg) {
    memberDirs.push(".");
  } else {
    diagnostics.push(blocking("workspace.no-members", "Cargo.toml", "neither [workspace] nor [package] is present"));
  }

  const manifests: CrateManifest[] = [];
  const memberNames = new Set<string>();
  const memberDirToName = new Map<string, string>();
  for (const rel of memberDirs) {
    const crateDir = rel === "." ? rootPath : join(rootPath, rel);
    const raw = readToml(join(crateDir, "Cargo.toml"));
    if (!raw) continue;
    const pkg = asRecord(raw.package) ?? {};
    const name = asString(pkg.name) ?? basename(crateDir);
    const rootForTargets = rel === "." ? rootToml : raw;
    const explicit = explicitTargets(pkg, rootForTargets);
    const automatic = detectAutoTargets(crateDir, pkg).filter(
      (target) =>
        !explicit.some(
          (entry) =>
            entry.kind === target.kind &&
            (target.kind === "lib" || entry.name === target.name || entry.src_path === target.src_path),
        ),
    );
    const targets = dedupeTargets([...explicit, ...automatic]);
    const manifest: CrateManifest = { name, path: rel, targets, internal_dependencies: [] };
    manifests.push(manifest);
    memberDirToName.set(crateDir, name);
    memberNames.add(name);
  }
  for (const manifest of manifests) {
    const rel = manifest.path;
    const crateDir = rel === "." ? rootPath : join(rootPath, rel);
    const raw = readToml(join(crateDir, "Cargo.toml")) ?? {};
    manifest.internal_dependencies = dependencyNames(crateDir, raw, memberNames, memberDirToName);
  }
  manifests.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { root_path: rootPath, members: manifests, diagnostics };
}

interface Placement {
  layerDir?: Exclude<Layer, "unknown">;
  cqrsDir?: Exclude<CqrsSide, "none">;
  compositionRootDir: boolean;
}

function scanPlacement(cratePath: string): Placement {
  const segments = cratePath === "." ? [] : cratePath.split("/");
  const result: Placement = { compositionRootDir: false };
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== "packages" && segments[i] !== "modules") continue;
    let j = i + 1;
    if ((CQRS_SEGMENTS as readonly string[]).includes(segments[j])) {
      result.cqrsDir = segments[j] as Exclude<CqrsSide, "none">;
      j++;
      if (segments[j] === "composition-root") {
        result.compositionRootDir = true;
        j++;
      }
    }
    if (segments[j] === "composition-root") {
      result.compositionRootDir = true;
      continue;
    }
    if ((LAYERS as readonly string[]).includes(segments[j])) {
      result.layerDir = segments[j] as Exclude<Layer, "unknown">;
    }
    if (result.layerDir || result.cqrsDir) return result;
  }
  return result;
}

function nameSide(crateName: string): Exclude<CqrsSide, "none"> | "conflict" | undefined {
  const segments = crateName.split("-");
  const has = (token: string) => segments.includes(token);
  const marks: Exclude<CqrsSide, "none">[] = [];
  if (has("command")) marks.push("command");
  if (has("query")) marks.push("query");
  if (crateName.endsWith("-rmu") || has("rmu")) marks.push("rmu");
  if (marks.length === 0) return undefined;
  if (marks.length > 1) return "conflict";
  return marks[0];
}

export function assignLayers(workspace: CargoWorkspace): CrateLayerAssignment[] {
  return workspace.members.map((member) => assignLayer(member, "Cargo.toml"));
}

/**
 * The layer, CQRS side and composition-root marker of one package, from its name and placement.
 * `manifestName` is the file that declares the package — `Cargo.toml` for a crate, `package.json`
 * for a TypeScript package — and is where each diagnostic about the package is reported.
 */
export function assignLayer(member: CrateManifest, manifestName: string): CrateLayerAssignment {
  const diagnostics: LayerDiagnostic[] = [];
  const manifestFile = member.path === "." ? manifestName : `${member.path}/${manifestName}`;
  const kinds = new Set(member.targets.map((t) => t.kind));
  const hasBin = kinds.has("bin");
  const hasLib = kinds.has("lib");
  const placement = scanPlacement(member.path);

  const assignment: CrateLayerAssignment = {
    crate_name: member.name,
    path: member.path,
    layer: "unknown",
    layer_source: "none",
    cqrs_side: "none",
    cqrs_source: "none",
    is_composition_root: false,
    targets: member.targets,
    diagnostics,
  };

  if (hasBin && hasLib) {
    diagnostics.push(
      blocking("layer.mixed-targets", manifestFile, `${member.name} has both bin and lib targets`, member.name),
    );
  }

  const binOnly = hasBin && !hasLib;
  const suffixRoot = member.name.endsWith("-composition-root");
  if (binOnly || suffixRoot || placement.compositionRootDir) {
    assignment.is_composition_root = true;
    assignment.layer = "composition-root";
    assignment.layer_source = "marker";
    sortDiagnostics(diagnostics);
    return assignment;
  }

  const segSide = nameSide(member.name);
  const dirSide = placement.cqrsDir;
  if (segSide === "conflict") {
    diagnostics.push(
      blocking("cqrs.conflict", manifestFile, `${member.name} carries more than one CQRS side marker`, member.name),
    );
  } else if (segSide !== undefined && dirSide !== undefined && segSide !== dirSide) {
    diagnostics.push(
      blocking(
        "cqrs.conflict",
        manifestFile,
        `${member.name} names CQRS side ${segSide} but sits under ${dirSide}/`,
        member.name,
      ),
    );
  } else if (segSide !== undefined && dirSide !== undefined) {
    assignment.cqrs_side = segSide;
    assignment.cqrs_source = "both";
  } else if (segSide !== undefined) {
    assignment.cqrs_side = segSide;
    assignment.cqrs_source = "segment";
  } else if (dirSide !== undefined) {
    assignment.cqrs_side = dirSide;
    assignment.cqrs_source = "directory";
  }

  if (assignment.cqrs_side === "rmu") {
    assignment.layer = "rmu";
    assignment.layer_source = "marker";
    sortDiagnostics(diagnostics);
    return assignment;
  }

  const suffix = LAYER_SUFFIXES.find(([s]) => member.name.endsWith(s))?.[1];
  const dirLayer = placement.layerDir;
  if (suffix !== undefined && dirLayer !== undefined && suffix !== dirLayer) {
    assignment.layer = "unknown";
    assignment.layer_source = "none";
    diagnostics.push(
      blocking(
        "layer.conflict",
        manifestFile,
        `${member.name} suffix says ${suffix} but placement says ${dirLayer}`,
        member.name,
      ),
    );
  } else if (suffix !== undefined && dirLayer !== undefined) {
    assignment.layer = suffix;
    assignment.layer_source = "both";
  } else if (suffix !== undefined) {
    assignment.layer = suffix;
    assignment.layer_source = "suffix";
  } else if (dirLayer !== undefined) {
    assignment.layer = dirLayer;
    assignment.layer_source = "directory";
  } else {
    assignment.layer = "unknown";
    assignment.layer_source = "none";
    diagnostics.push(
      blocking("layer.unknown", manifestFile, `${member.name} matches no layer suffix or placement`, member.name),
    );
  }

  if (assignment.cqrs_side === "query" && assignment.layer === "domain") {
    diagnostics.push(
      blocking("cqrs.query-domain", manifestFile, `${member.name} is a query-side domain crate`, member.name),
    );
  }

  sortDiagnostics(diagnostics);
  return assignment;
}

function sortDiagnostics(diagnostics: LayerDiagnostic[]): void {
  diagnostics.sort((a, b) => {
    const byCode = a.code.localeCompare(b.code, "en");
    if (byCode !== 0) return byCode;
    return (a.crate_name ?? "").localeCompare(b.crate_name ?? "", "en");
  });
}

export function classifyFile(assignments: readonly CrateLayerAssignment[], filePath: string): FileClassification {
  const file = filePath.split("\\").join("/");
  let best: CrateLayerAssignment | undefined;
  for (const assignment of assignments) {
    const prefix = assignment.path === "." ? "" : `${assignment.path}/`;
    if (assignment.path !== "." && !file.startsWith(prefix)) continue;
    if (best === undefined || assignment.path.length > best.path.length) best = assignment;
  }
  if (best === undefined) {
    return { file, target_kind: "unknown", role: "unowned", effective_layer: "unknown", cqrs_side: "none" };
  }
  const crateRel = best.path === "." ? file : file.slice(best.path.length + 1);
  const target = best.targets.find((t) => t.src_path === crateRel);
  const target_kind: CargoTargetKind | "unknown" = target?.kind ?? "unknown";
  const base = { file, crate_name: best.crate_name, target_kind, cqrs_side: best.cqrs_side };
  if (/^(tests|examples|benches)\//.test(crateRel) || crateRel === "build.rs") {
    return { ...base, role: "auxiliary", effective_layer: "auxiliary" };
  }
  if (best.is_composition_root) {
    return { ...base, role: "composition-root", effective_layer: "composition-root" };
  }
  return { ...base, role: "crate-source", effective_layer: best.layer };
}

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "interface-adapter": ["use-case", "domain", "infrastructure"],
  "use-case": ["domain", "infrastructure"],
  domain: ["infrastructure"],
  rmu: ["domain", "interface-adapter", "infrastructure"],
  "composition-root": ["domain", "use-case", "interface-adapter", "infrastructure", "rmu", "composition-root"],
  infrastructure: [],
};

export function permissionTable(): DependencyPermission[] {
  const layers = ["domain", "use-case", "interface-adapter", "infrastructure", "rmu", "composition-root"] as const;
  const rows: DependencyPermission[] = [];
  for (const from of layers) {
    for (const to of layers) {
      const allowed = from === to || (ALLOWED[from] ?? []).includes(to);
      rows.push({ from_layer: from, to_layer: to, allowed, cross_side_allowed: from === "rmu" });
    }
  }
  return rows;
}

export function isAllowed(
  from: CrateLayerAssignment | FileClassification,
  to: CrateLayerAssignment | FileClassification,
): {
  allowed: boolean;
  reason: "ok" | "layer-forbidden" | "cross-side";
} {
  const fromLayer = "layer" in from ? from.layer : from.effective_layer;
  const toLayer = "layer" in to ? to.layer : to.effective_layer;
  const fromSide = from.cqrs_side;
  const toSide = to.cqrs_side;
  // `rmu` never satisfies `opposite`, so it is already exempt from the cross-side
  // rule without a second test — one that TypeScript flags as unreachable (TS2367).
  const opposite = (fromSide === "command" && toSide === "query") || (fromSide === "query" && toSide === "command");
  if (opposite) {
    return { allowed: false, reason: "cross-side" };
  }
  if (fromLayer === toLayer) return { allowed: true, reason: "ok" };
  const allowed = (ALLOWED[fromLayer] ?? []).includes(toLayer);
  return allowed ? { allowed: true, reason: "ok" } : { allowed: false, reason: "layer-forbidden" };
}

export function conventions(): Record<string, unknown> {
  return {
    layer_suffixes: {
      "-domain": "domain",
      "-use-case": "use-case",
      "-interface-adapter": "interface-adapter",
      "-infrastructure": "infrastructure",
    },
    placement: "packages/<layer>/ or modules/<layer>/ (an optional command|query|rmu segment may precede <layer>)",
    cqrs_segments: ["command", "query", "rmu"],
    composition_root: "bin-only crate, -composition-root suffix, or packages|modules/composition-root/",
    layer_order: "domain, use-case, interface-adapter, infrastructure, rmu, composition-root, unknown",
    cqrs_sides: ["command", "query", "rmu", "none"],
  };
}
