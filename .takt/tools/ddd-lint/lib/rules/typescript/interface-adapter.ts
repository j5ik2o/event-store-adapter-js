/**
 * TypeScript rule evaluators of the interface-adapter gate: query-side references to a domain type
 * or a repository port (l), repository naming (m) and restoration bypass (n), each in the words the
 * Rust interface-adapter gate reports them in. The cross-side rule (k) and the dependency direction
 * (g) are in `edges.ts`.
 *
 * Nothing here infers a type. A reference is what an import or a re-export names, and a constructed
 * type is what the source spells; what those do not decide is left undecided rather than passed.
 */

import { join } from "node:path";
import type { FindingInput } from "../../shared/findings.ts";
import { containsMediaWord, toPascal } from "../lists.ts";
import { packageContaining, resolveSpecifier } from "./edges.ts";
import { factsOf } from "./file-facts.ts";
import { importedDomainType, isPortDeclaration, resolveConstructedType } from "./symbols.ts";
import type { TsInspection, TsTarget } from "./types.ts";

// --- (l) query side domain / repository reference ------------------------------------------------

/** One name a query-side source takes from another module: an import binding or a re-exported name. */
interface TakenName {
  readonly specifier: string;
  /** The name the module exports it under; `default` for a default import. */
  readonly name: string;
  readonly line: number;
}

/** Whether `specifier`, written in `file`, leads into a package of the domain layer. */
function leadsToDomain(inspection: TsInspection, file: string, specifier: string): boolean {
  const absolute = join(inspection.packages.workspaceRoot, file);
  const from = packageContaining(inspection.packages, absolute);
  if (!from) throw new Error(`no package of the project holds ${file}`);
  const target = resolveSpecifier(inspection.packages, from, absolute, specifier);
  return (
    target.kind === "package" && target.pkg.assignment.layer === "domain" && !target.pkg.assignment.is_composition_root
  );
}

/**
 * The names a query-side source takes. A dependency on the domain layer that names no binding the
 * source spells — a namespace import, `export *`, a dynamic import, an import type — can reach any
 * domain type, so it is left undecided. Whether such a dependency leads into the domain layer is not
 * asked of a specifier the dependency direction cannot follow: that rule, which decides the same
 * dependencies of the same source, leaves it undecided.
 */
function takenNames(inspection: TsInspection, target: TsTarget): TakenName[] {
  const facts = factsOf(inspection, target.file);
  const taken: TakenName[] = [];
  const opaque = (specifier: string, line: number, what: string) => {
    if (leadsToDomain(inspection, target.file, specifier))
      inspection.undecided.add(target.file, line, `${what} of the domain package "${specifier}" on the query side`);
  };
  for (const entry of facts.imports) {
    if (entry.kind === "dynamic" || entry.kind === "type-query") {
      opaque(entry.specifier, entry.line, entry.kind === "dynamic" ? "a dynamic import" : "an import type");
      continue;
    }
    for (const binding of entry.bindings) {
      if (binding.imported === "*") opaque(entry.specifier, entry.line, "a namespace import");
      else taken.push({ specifier: entry.specifier, name: binding.imported, line: entry.line });
    }
  }
  for (const entry of facts.exports) {
    if (entry.specifier === undefined) continue;
    if (entry.kind === "all" || entry.kind === "namespace") {
      opaque(entry.specifier, entry.line, "export *");
      continue;
    }
    for (const name of entry.names) taken.push({ specifier: entry.specifier, name: name.local, line: entry.line });
  }
  return taken;
}

/**
 * A query-side source that takes a domain type, or anything named `…Repository`, from another
 * module. The Rust gate decides the query side by the name a `use` spells; the name decided here is
 * the one the module exports, so an import under another name is the same reference.
 */
export function ruleL(inspection: TsInspection, target: TsTarget): FindingInput[] {
  if (target.pkg.assignment.cqrs_side !== "query") return [];
  const findings: FindingInput[] = [];
  for (const taken of takenNames(inspection, target)) {
    const resolved = importedDomainType(
      inspection.packages,
      inspection.symbols,
      target.file,
      taken.specifier,
      taken.name,
    );
    if (resolved.kind === "undecided") {
      inspection.undecided.add(target.file, taken.line, `query-side reference ${taken.name}: ${resolved.reason}`);
      continue;
    }
    const name = resolved.kind === "domain" ? resolved.type.name : taken.name;
    if (resolved.kind === "domain" || name.endsWith("Repository"))
      findings.push({
        rule_id: "l",
        file: target.file,
        message: `query side references domain type / repository port ${name}`,
        line: taken.line,
      });
  }
  return findings;
}

// --- (m) repository naming ------------------------------------------------------------------------

/** The aggregate names a repository is named after: the model's, else every domain type's. */
function aggregateNames(inspection: TsInspection): Set<string> {
  const names = new Set<string>();
  const index = inspection.model.status === "available" ? inspection.model.index : undefined;
  if (index) for (const element of index.elements("aggregate")) names.add(toPascal(element.id.segments[0]));
  if (names.size === 0) for (const type of inspection.symbols.types) names.add(type.name);
  return names;
}

/**
 * Repository naming: a port — an interface, or a type literal alias — named `…Repository` is named
 * `<Aggregate>Repository` and names no storage medium; an implementation — a class — named
 * `…Repository` may name its medium, but is still named after an aggregate.
 */
export function ruleM(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const aggregates = aggregateNames(inspection);
  const namedAfterAggregate = (name: string) => {
    const stem = name.slice(0, -"Repository".length);
    return [...aggregates].some((aggregate) => stem === aggregate || stem.endsWith(aggregate));
  };
  const findings: FindingInput[] = [];
  for (const declaration of factsOf(inspection, target.file).declarations) {
    if (!declaration.name.endsWith("Repository")) continue;
    const line = declaration.span.start_line;
    if (isPortDeclaration(declaration)) {
      if (!namedAfterAggregate(declaration.name))
        findings.push({
          rule_id: "m",
          file: target.file,
          message: `repository port ${declaration.name} is not <Aggregate>Repository`,
          line,
        });
      if (containsMediaWord(declaration.name))
        findings.push({
          rule_id: "m",
          file: target.file,
          message: `repository port ${declaration.name} names a storage medium`,
          line,
        });
    } else if (declaration.kind === "class" && !namedAfterAggregate(declaration.name))
      findings.push({
        rule_id: "m",
        file: target.file,
        message: `repository type ${declaration.name} is not <Aggregate>Repository`,
        line,
      });
  }
  return findings;
}

// --- (n) restoration bypass -----------------------------------------------------------------------

/**
 * An adapter that builds a domain type itself — `new` of a class, a literal typed as the type, an
 * assertion to it — rather than restoring it through a factory the type offers.
 */
export function ruleN(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const facts = factsOf(inspection, target.file);
  const findings: FindingInput[] = [];
  for (const site of facts.constructions) {
    const resolved = resolveConstructedType(
      inspection.packages,
      inspection.symbols,
      target.file,
      facts,
      site.type_text,
    );
    if (resolved.kind === "undecided") {
      inspection.undecided.add(target.file, site.span.start_line, `constructed type: ${resolved.reason}`);
      continue;
    }
    if (resolved.kind !== "domain") continue;
    // Only a class is constructed by `new`.
    if (site.kind === "new-expression" && resolved.type.kind !== "class") continue;
    findings.push({
      rule_id: "n",
      file: target.file,
      message: `adapter constructs ${resolved.type.name} via ${site.kind} instead of a full constructor`,
      line: site.span.start_line,
    });
  }
  return findings;
}
