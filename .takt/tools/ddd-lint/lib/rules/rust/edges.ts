/**
 * DependencyEdge builder — from `use` paths and Cargo dependencies,
 * with the workspace's isAllowed and the I/O denylist attaching the verdict.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainFactSet } from "../../rust/domain-facts/index.ts";
import { type CrateLayerAssignment, isAllowed } from "../../workspace/resolver.ts";
import { type ExternalCrateRule, matchesIoRule } from "../lists.ts";
import type { DependencyEdge, InspectionTarget } from "../types.ts";

const LOCAL_SEGMENTS = new Set(["crate", "self", "super", "std", "core", "alloc"]);

function normalize(crateName: string): string {
  return crateName.replace(/_/g, "-");
}

/**
 * The crate a `use` path names, as a Cargo crate name is written. A trailing rename belongs to the
 * item rather than to the crate, a brace opens the list of items, and Cargo writes with hyphens
 * what Rust writes with underscores.
 */
function firstSegment(pathText: string): string {
  const withoutAlias = pathText.replace(/\s+as\s+[A-Za-z0-9_]+\s*$/, "");
  return withoutAlias.replace(/^::/, "").split("::")[0].replace(/\{.*$/, "").trim().replace(/-/g, "_");
}

export function buildEdges(
  facts: DomainFactSet,
  targets: readonly InspectionTarget[],
  assignments: readonly CrateLayerAssignment[],
  workspaceRoot: string,
  denylist: readonly ExternalCrateRule[],
): DependencyEdge[] {
  const byName = new Map(assignments.map((assignment) => [assignment.crate_name, assignment]));
  const memberNames = new Set(assignments.map((assignment) => normalize(assignment.crate_name)));
  const edges: DependencyEdge[] = [];

  const verdictFor = (from: CrateLayerAssignment, to: CrateLayerAssignment): DependencyEdge["verdict"] => {
    const result = isAllowed(from, to);
    return result.reason === "ok" ? "ok" : result.reason;
  };

  for (const target of targets) {
    if (!target.file || !target.crate_name) continue;
    const from = byName.get(target.crate_name);
    if (!from) continue;
    const file = target.file;
    const declared = facts.files.get(file);
    // `requireDecisionBase` runs before these edges are built and sends every inspected file the
    // extractor did not answer for to the tool-unavailable terminal, so this is unreachable unless
    // that guard and this build disagree about which files the batch covered. Skipping the file
    // would leave rules (g) and (k) with no edge to judge and pass a run nothing was read for.
    if (!declared) throw new Error(`the native facts carry no declarations for ${file}`);
    for (const use of declared.uses) {
      const first = firstSegment(use.path_text);
      if (LOCAL_SEGMENTS.has(first)) continue;
      if (memberNames.has(normalize(first))) {
        const to = byName.get(first) ?? byName.get(normalize(first));
        if (to) {
          edges.push({
            from_crate: from.crate_name,
            to_crate: to.crate_name,
            evidence: "use-path",
            file,
            line: use.line,
            verdict: verdictFor(from, to),
          });
        }
        continue;
      }
      const io = matchesIoRule(normalize(first), denylist);
      if (io) {
        edges.push({
          from_crate: from.crate_name,
          to_crate: first,
          evidence: "use-path",
          file,
          line: use.line,
          verdict: from.layer === "domain" || from.layer === "use-case" ? "external-io" : "ok",
        });
      }
    }
  }

  // Cargo internal dependencies (file = the from crate's Cargo.toml).
  const fromCrates = new Set(
    targets.map((target) => target.crate_name).filter((name): name is string => name !== undefined),
  );
  for (const crateName of fromCrates) {
    const from = byName.get(crateName);
    if (!from) continue;
    const cargoToml = from.path === "." ? "Cargo.toml" : `${from.path}/Cargo.toml`;
    const deps = cargoDependencies(workspaceRoot, from.path);
    for (const dep of deps) {
      const to = byName.get(dep);
      if (!to) {
        // External dependency: only the denylist is an edge.
        const io = matchesIoRule(normalize(dep), denylist);
        if (!io) continue;
        const alreadyExternal = edges.some(
          (edge) => edge.from_crate === from.crate_name && edge.to_crate === dep && edge.evidence === "use-path",
        );
        if (alreadyExternal) continue;
        edges.push({
          from_crate: from.crate_name,
          to_crate: dep,
          evidence: "cargo-dependency",
          file: cargoToml,
          verdict: from.layer === "domain" || from.layer === "use-case" ? "external-io" : "ok",
        });
        continue;
      }
      const already = edges.some(
        (edge) =>
          edge.from_crate === from.crate_name && edge.to_crate === to.crate_name && edge.evidence === "use-path",
      );
      if (already) continue;
      edges.push({
        from_crate: from.crate_name,
        to_crate: to.crate_name,
        evidence: "cargo-dependency",
        file: cargoToml,
        verdict: verdictFor(from, to),
      });
    }
  }

  edges.sort((a, b) => {
    const byFile = a.file.localeCompare(b.file, "en");
    if (byFile !== 0) return byFile;
    const byLine = (a.line ?? 0) - (b.line ?? 0);
    if (byLine !== 0) return byLine;
    return a.to_crate.localeCompare(b.to_crate, "en");
  });
  return edges;
}

function cargoDependencies(workspaceRoot: string, cratePath: string): string[] {
  const path = join(workspaceRoot, cratePath === "." ? "Cargo.toml" : `${cratePath}/Cargo.toml`);
  if (!existsSync(path)) return [];
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const names: string[] = [];
    for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      const deps = parsed[section];
      if (typeof deps !== "object" || deps === null) continue;
      for (const name of Object.keys(deps as Record<string, unknown>)) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}
