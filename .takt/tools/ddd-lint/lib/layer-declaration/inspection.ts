/**
 * The layer rules a declaration that loaded still has to follow.
 *
 * The loader decides whether the document says something the format can read; this decides whether
 * what it says is a sound layering. The two are separate entry points because a team reviewing the
 * layering does not need the document reread.
 *
 * Nothing here knows how a language spells a name, apart from the one place where the layering rule
 * itself is about a name: a query-side package may not reach into the domain layer, and the domain
 * layer is what a package name marks.
 */

import { packageWord } from "../packaging/declarations.ts";
import type { DomainModel } from "../schema/model.ts";
import type { FindingInput } from "../shared/findings.ts";
import { barePackageName } from "../shared/package-name.ts";
import {
  describeIdentity,
  identityKey,
  LAYER_RULES,
  type LayerDeclaration,
  LayerReport,
  type LayerStructure,
  type PackageIdentity,
  type PackageRole,
  structureWhere,
} from "./contract.ts";

/**
 * Whether the package name carries the domain layer marker. `packageWord` is the business word a
 * package name stands for: the same name with a trailing `-domain` or `_domain` removed and its
 * word separators normalised. Comparing it against that normalisation alone says whether the marker
 * was there, so the marker stays spelled in one place. A scope names the publisher rather than the
 * package, so it is set aside first and `@acme/shared-domain` is read the same way `shared-domain` is.
 */
function carriesDomainMarker(identity: PackageIdentity): boolean {
  const bare = barePackageName(identity.language, identity.package).toLowerCase();
  return packageWord(bare) !== bare.replace(/-/g, "_");
}

function checkRequiredItems(
  report: LayerReport,
  structure: LayerStructure,
  domainPackages: ReadonlySet<string>,
  where: string,
): void {
  const aggregateOnlyWithoutPersistence =
    structure.persistence_backend === "none" &&
    structure.ports.length === 0 &&
    structure.repositories.length === 0 &&
    structure.packages.length > 0 &&
    structure.packages.every((entry) => domainPackages.has(identityKey(entry.code)));
  if (
    structure.dependencies.length === 0 ||
    (!aggregateOnlyWithoutPersistence && structure.ports.length === 0) ||
    (!aggregateOnlyWithoutPersistence && structure.repositories.length === 0) ||
    structure.restoration_paths.length === 0
  )
    report.add(
      LAYER_RULES.requiredItems,
      `${where}: at least one of the dependencies, ports, repositories and restoration paths of the context is empty`,
    );
}

function checkDependencyRows(report: LayerReport, structure: LayerStructure, where: string): void {
  const rows = new Set(structure.dependencies.map((row) => identityKey(row.code)));
  for (const entry of structure.packages) {
    if (!rows.has(identityKey(entry.code)))
      report.add(
        LAYER_RULES.dependencyRow,
        `${where}: the package ${describeIdentity(entry.code)} has no dependency row`,
      );
  }
}

/**
 * The edges each side may follow. The read-model updater is the one package that is meant to see
 * both sides, so its rows are what the side rules are not about.
 */
function checkDependencyDirection(report: LayerReport, structure: LayerStructure, where: string): void {
  const roles = new Map<string, PackageRole>(structure.packages.map((entry) => [identityKey(entry.code), entry.role]));
  for (const row of structure.dependencies) {
    const role = roles.get(identityKey(row.code));
    if (role === undefined || role === "rmu") continue;
    const from = describeIdentity(row.code);
    for (const target of row.depends_on) {
      const to = describeIdentity(target);
      const targetRole = roles.get(identityKey(target));
      if (role === "command" && targetRole === "query")
        report.add(LAYER_RULES.sideDependency, `${where}: the command-side package ${from} depends on ${to}`);
      if (role === "query" && targetRole === "command")
        report.add(LAYER_RULES.sideDependency, `${where}: the query-side package ${from} depends on ${to}`);
      if (role === "query" && carriesDomainMarker(target))
        report.add(
          LAYER_RULES.queryDomainDependency,
          `${where}: the query-side package ${from} depends on the domain-layer package ${to}`,
        );
    }
  }
}

/** Every aggregate of the context is rebuilt through a constructor that takes all of its state. */
function checkRestorationPaths(
  report: LayerReport,
  structure: LayerStructure,
  model: DomainModel,
  where: string,
): void {
  const context = model.bounded_contexts.find((candidate) => candidate.element_id === structure.context_ref);
  if (context === undefined) return;
  for (const aggregate of context.aggregates) {
    const path = structure.restoration_paths.find((entry) => entry.aggregate_ref === aggregate.element_id);
    if (path?.via !== "full-constructor")
      report.add(
        LAYER_RULES.restorationPath,
        `${where}: the aggregate ${aggregate.element_id} has no full-constructor restoration path`,
      );
  }
}

/**
 * Runs the layer rules against a declaration the loader accepted, reported against `file`. Returns
 * findings and nothing else: what to do with them belongs to whoever asked.
 */
export function inspectLayerDeclaration(
  declaration: LayerDeclaration,
  model: DomainModel,
  file: string,
  domainPackages: readonly PackageIdentity[],
): readonly FindingInput[] {
  const report = new LayerReport(file);
  const domainPackageKeys = new Set(domainPackages.map(identityKey));
  for (const structure of declaration.layer_structures) {
    const where = structureWhere(structure.context_ref);
    checkRequiredItems(report, structure, domainPackageKeys, where);
    checkDependencyRows(report, structure, where);
    if (structure.cqrs && !structure.packages.some((entry) => entry.role === "query"))
      report.add(LAYER_RULES.cqrsSides, `${where}: the context is cqrs but declares no query-side package`);
    checkDependencyDirection(report, structure, where);
    checkRestorationPaths(report, structure, model, where);
  }
  return report.findings;
}
