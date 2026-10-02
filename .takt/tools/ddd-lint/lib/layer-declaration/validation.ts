/**
 * Checks a draft declaration against the canonical model it names, and against itself.
 *
 * Findings are defects of what the declaration says: a business reference the model does not answer,
 * the same thing declared twice, or a dependency row for a package this context never declared. None
 * of them needs a value the crate format left unsaid, so the check runs on the draft and a defect is
 * therefore known before anything is reported as still missing.
 */

import type { ElementKind } from "../schema/element-id.ts";
import type { ElementIndex, ResolveReason } from "../schema/index-builder.ts";
import type { FindingInput } from "../shared/findings.ts";
import {
  describeIdentity,
  identityKey,
  LAYER_RULES,
  type LayerDeclarationDraft,
  LayerReport,
  type PackageIdentity,
  structureWhere,
} from "./contract.ts";

interface ExpectedElement {
  readonly kind: ElementKind;
  readonly label: string;
}

const BOUNDED_CONTEXT: ExpectedElement = { kind: "bc", label: "a bounded context" };
const AGGREGATE: ExpectedElement = { kind: "aggregate", label: "an aggregate" };

function unresolved(reason: ResolveReason, expected: ExpectedElement): string {
  switch (reason) {
    case "undefined":
      return "is not defined by the canonical model";
    case "deprecated":
      return "is retired by the model lineage";
    case "kind-mismatch":
      return `does not name ${expected.label}`;
    case "malformed":
      return "is not a model element id";
  }
}

function resolveReference(
  report: LayerReport,
  index: ElementIndex,
  id: string,
  where: string,
  expected: ExpectedElement,
): void {
  const result = index.resolve(id, expected.kind);
  if (result.ok) return;
  report.add(LAYER_RULES.reference, `${where}: ${JSON.stringify(id)} ${unresolved(result.reason, expected)}`);
}

/** Records `key` and reports when it was already recorded; the duplicate itself is never resolved away. */
function first(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function checkPackages(
  report: LayerReport,
  packages: readonly { code: PackageIdentity }[],
  where: string,
): Set<string> {
  const declared = new Set<string>();
  for (const entry of packages) {
    if (!first(declared, identityKey(entry.code)))
      report.add(
        LAYER_RULES.duplicate,
        `${where}.packages[${describeIdentity(entry.code)}]: the package is declared more than once`,
      );
  }
  return declared;
}

/**
 * Every dependency row against the packages this context declared. A row belongs to a package, so a
 * row for a package the context never declared is a gap in the declaration. What a row depends on may
 * lie outside the context, as it could in the crate format, and the rule against a query-side
 * dependency on the domain layer still judges that edge by the package's name, so a target is kept as
 * written and only checked for being named twice.
 */
function checkDependencies(
  report: LayerReport,
  structure: LayerDeclarationDraft["layer_structures"][number],
  declared: ReadonlySet<string>,
  where: string,
): void {
  const rows = new Set<string>();
  for (const row of structure.dependencies) {
    const at = `${where}.dependencies[${describeIdentity(row.code)}]`;
    if (!first(rows, identityKey(row.code)))
      report.add(LAYER_RULES.duplicate, `${at}: the package has more than one dependency row`);
    if (!declared.has(identityKey(row.code)))
      report.add(LAYER_RULES.coverage, `${at}: this context declares no such package`);
    const targets = new Set<string>();
    for (const target of row.depends_on) {
      const named = describeIdentity(target);
      if (!first(targets, identityKey(target)))
        report.add(LAYER_RULES.duplicate, `${at}.depends_on: ${named} is named more than once`);
    }
  }
}

/** Every defect of the declaration itself, reported against the document it was read from. */
export function validateLayerDraft(
  draft: LayerDeclarationDraft,
  index: ElementIndex,
  file: string,
): readonly FindingInput[] {
  const report = new LayerReport(file);
  const contexts = new Set<string>();
  for (const structure of draft.layer_structures) {
    const where = structureWhere(structure.context_ref);
    if (!first(contexts, structure.context_ref))
      report.add(LAYER_RULES.duplicate, `${where}: another structure already declares this context`);
    resolveReference(report, index, structure.context_ref, `${where}.context_ref`, BOUNDED_CONTEXT);

    checkDependencies(report, structure, checkPackages(report, structure.packages, where), where);

    const ports = new Set<string>();
    for (const port of structure.ports) {
      const at = `${where}.ports[${port.name}]`;
      if (!first(ports, port.name)) report.add(LAYER_RULES.duplicate, `${at}: another port already carries this name`);
    }

    const names = new Set<string>();
    for (const repository of structure.repositories) {
      const at = `${where}.repositories[${repository.name}]`;
      if (!first(names, repository.name))
        report.add(LAYER_RULES.duplicate, `${at}: another repository already carries this name`);
      resolveReference(report, index, repository.aggregate_ref, `${at}.aggregate_ref`, AGGREGATE);
    }

    const restored = new Set<string>();
    for (const path of structure.restoration_paths) {
      const at = `${where}.restoration_paths[${path.aggregate_ref}]`;
      if (!first(restored, path.aggregate_ref))
        report.add(LAYER_RULES.duplicate, `${at}: the aggregate already has a restoration path`);
      resolveReference(report, index, path.aggregate_ref, `${at}.aggregate_ref`, AGGREGATE);
    }
  }
  return report.findings;
}
