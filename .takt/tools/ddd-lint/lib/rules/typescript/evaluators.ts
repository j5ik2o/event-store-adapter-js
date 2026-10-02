/**
 * TypeScript rule evaluators of the domain gate: undeclared mutation (b), incomplete construction
 * (c), getter calls (d) and domain packaging, each in the words the Rust domain gate reports them
 * in. State hiding (a) is in `state-hiding.ts` and the dependency direction (g) in `edges.ts`.
 * Getter calls (d) are decided the same way over a use-case source, where a getter result handed
 * unchanged to a repository port is the one call the rule permits. What the rules of every gate read
 * off a file's facts is in `file-facts.ts`, and the binding of a type to a model aggregate in
 * `aggregate-binding.ts`.
 *
 * Nothing here infers a type. A receiver or a constructed type is what a declaration, an import or
 * an annotation spells, and what those do not decide is left undecided rather than passed.
 */

import { join } from "node:path";
import { mappingPathOf } from "../../aggregate-mapping/index.ts";
import { SPELLINGS } from "../../aggregate-mapping/language.ts";
import {
  type DeclaredPackages,
  type PackagingModule,
  type PackagingProblem,
  packagingFindings,
} from "../../packaging/evaluate.ts";
import { relPath } from "../../project/context.ts";
import type { FindingInput } from "../../shared/findings.ts";
import {
  type CallFact,
  COLLECTION_MUTATORS,
  type Span,
  type TypeScriptFileFacts,
} from "../../typescript/domain-facts/index.ts";
import { POST_INIT } from "../lists.ts";
import { operationOwner } from "../operation-owner.ts";
import { aggregateMappings, locatedAt } from "./aggregate-binding.ts";
import { factsOf, receiverType } from "./file-facts.ts";
import { modulePathOf, PACKAGE_MANIFEST, packageSources, posixRelative, type TsPackage } from "./packages.ts";
import { isPortDeclaration, resolveConstructedType, resolveDeclaredType, resolveTypeName, within } from "./symbols.ts";
import type { TsDomainType, TsInspection, TsMethod, TsTarget } from "./types.ts";

// --- state changes --------------------------------------------------------------------------------

const COLLECTION_TYPE = /^(?:Array|Map|Set)\s*<|\[\]$/;

/**
 * Whether a class method changes state: it writes state, or it calls a changing method of a field
 * the class states is an array, a `Map` or a `Set`.
 */
function mutates(type: TsDomainType, method: TsMethod, calls: readonly CallFact[]): boolean {
  if (method.writes.length > 0) return true;
  if (type.kind !== "class") return false;
  return calls.some((call) => {
    if (call.kind !== "method-call" || !within(call.span, method.span) || !COLLECTION_MUTATORS.has(call.callee_text))
      return false;
    const field = /^this\.(#?[A-Za-z_$][\w$]*)$/.exec((call.receiver_text ?? "").replace(/\s+/g, ""))?.[1];
    const member = field === undefined ? undefined : type.members.find((entry) => entry.name === field);
    return member?.kind === "property" && COLLECTION_TYPE.test((member.type_text ?? "").trim());
  });
}

// --- (immutable) a TypeScript domain instance never changes after construction -------------------

/**
 * TypeScript shares references freely, so a domain instance that changes in place changes for every
 * holder. Every method that writes state is a finding, commands and replay methods included: they
 * build the changed state into a new instance through the full constructor instead. A post-init
 * method is (c)'s. A `#` field of a class is declared `readonly`.
 */
export function ruleImmutable(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const calls = factsOf(inspection, target.file).calls;
  const findings: FindingInput[] = [];
  for (const type of inspection.symbols.types.filter((entry) => entry.file === target.file)) {
    for (const method of type.methods) {
      if (POST_INIT.has(method.name) || !mutates(type, method, calls)) continue;
      findings.push({
        rule_id: "immutable",
        file: target.file,
        message: `method ${type.name}.${method.name} changes state in place; return a new instance built through the full constructor`,
        line: method.span.start_line,
      });
    }
    if (type.kind !== "class") continue;
    for (const member of type.members) {
      if (member.kind !== "property" || member.static || !member.name.startsWith("#") || member.readonly) continue;
      findings.push({
        rule_id: "immutable",
        file: target.file,
        message: `field ${type.name}.${member.name} is not readonly`,
        line: member.span.start_line,
      });
    }
  }
  return findings;
}

// --- (operation) every mapped operation is a method returning the mapped Result -----------------

function withoutSpaces(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * Every operation the mapping places on a type of this file is a method of that type — a static
 * method or a companion factory for a factory rule, an instance method for a command — whose stated
 * return type is `Result<success, error>`: the mapped success type (the aggregate type for a factory
 * rule) and the mapped error type.
 */
export function ruleOperation(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const findings: FindingInput[] = [];
  const facts = factsOf(inspection, target.file);
  for (const type of inspection.symbols.types.filter((entry) => entry.file === target.file)) {
    // The operations whose method this type owns: the aggregate's own, where the mapping places the
    // aggregate at this type, and the factories of the other elements this type is.
    const owned = aggregateMappings(inspection)
      .filter((entry) => entry.package === type.pkg.name)
      .flatMap((entry) =>
        entry.operations.filter((operation) =>
          operationOwner(inspection.model, operation.operation_ref, entry.type) === type.name &&
          (entry.type !== type.name || locatedAt(type)(entry)),
        ),
      );
    if (owned.length === 0) continue;
    const companionObject =
      type.kind === "companion"
        ? facts.declarations.find((entry) => entry.kind === "variable" && entry.name === type.name)
        : undefined;
    for (const operation of owned) {
      const factory = operation.operation_ref.startsWith("factory.");
      const members =
        type.kind === "class" ? type.members.filter((member) => member.static === factory) : factory ? (companionObject?.members ?? []) : type.members;
      const methods = members.filter((member) => member.kind === "method" && member.name === operation.method);
      const success = operation.success_type ?? type.name;
      const expected = `Result<${success}, ${operation.error_type}>`;
      if (methods.length === 0) {
        findings.push({
          rule_id: "operation",
          file: target.file,
          message: `${type.name} has no ${factory ? "factory" : "command"} method ${operation.method} for ${operation.operation_ref}`,
          line: type.home.start_line,
        });
        continue;
      }
      for (const method of methods) {
        const stated = method.return_type_text;
        if (stated !== undefined && withoutSpaces(stated) === withoutSpaces(expected)) continue;
        findings.push({
          rule_id: "operation",
          file: target.file,
          message: `${type.name}.${operation.method} (${operation.operation_ref}) returns ${stated ?? "an unstated type"}; the mapping says ${expected}`,
          line: method.span.start_line,
        });
      }
    }
  }
  return findings;
}

// --- (collection) a domain type holds no bare collection beside other state ------------------------

const BARE_COLLECTION_TS = /^(?:readonly\s+)?[^\s]+\[\]$|^(?:Readonly)?(?:Array|Set|Map)\s*<|^ReadonlyArray\s*</;

/**
 * A domain type whose state holds a collection (an array, a `Set`, a `Map`) beside other state
 * wraps it in a first-class collection type. A type whose whole state is one collection is the
 * first-class collection itself. A class is judged by its `#` fields; a companion by the parameters
 * of its full-constructor factory (the one that returns the type itself).
 */
export function ruleCollection(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const findings: FindingInput[] = [];
  const facts = factsOf(inspection, target.file);
  for (const type of inspection.symbols.types.filter((entry) => entry.file === target.file)) {
    const state =
      type.kind === "class"
        ? type.members
            .filter((member) => member.kind === "property" && !member.static && member.name.startsWith("#"))
            .map((member) => ({ name: member.name, type: member.type_text, line: member.span.start_line }))
        : (facts.declarations
            .find((entry) => entry.kind === "variable" && entry.name === type.name)
            ?.members.filter((member) => member.kind === "method" && member.return_type_text?.trim() === type.name)
            .sort((a, b) => (b.params?.length ?? 0) - (a.params?.length ?? 0))[0]
            ?.params?.map((param) => ({ name: param.name, type: param.type_text, line: type.home.start_line })) ?? []);
    if (state.length < 2) continue;
    const bare = state.filter((entry) => entry.type !== undefined && BARE_COLLECTION_TS.test(entry.type.trim()));
    // A companion's parameters share one line, so its bare collections are reported together.
    const groups = type.kind === "class" ? bare.map((entry) => [entry]) : bare.length > 0 ? [bare] : [];
    for (const group of groups)
      findings.push({
        rule_id: "collection",
        file: target.file,
        message: `${type.name} holds ${group.map((entry) => `${entry.name} (${entry.type?.trim()})`).join(", ")} as a bare collection; wrap it in a first-class collection type`,
        line: group[0].line,
      });
  }
  return findings;
}

// --- (port-placement) a port belongs to the use-case layer ----------------------------------------

/**
 * A repository port — an interface, or a type literal alias, named `…Repository` — declared in a
 * domain source. Ports belong to the use-case layer: the use case loads and stores through them, and
 * the domain never declares, holds or calls one. A port is known by its name, as rules (l) and (m)
 * know it.
 */
export function rulePortPlacement(inspection: TsInspection, target: TsTarget): FindingInput[] {
  return factsOf(inspection, target.file)
    .declarations.filter((declaration) => isPortDeclaration(declaration) && declaration.name.endsWith("Repository"))
    .map((declaration) => ({
      rule_id: "port-placement",
      file: target.file,
      message: `repository port ${declaration.name} is declared in the domain layer; declare it in the use-case layer`,
      line: declaration.span.start_line,
    }));
}

// --- (c) incomplete construction -----------------------------------------------------------------

export function ruleC(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const findings: FindingInput[] = [];
  const facts = factsOf(inspection, target.file);
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
    const type = resolved.type;
    // Only a class is constructed by `new`; inside its own class or companion object, a type is
    // made the way it is meant to be, and an assertion there is left to rule (a) as undecided.
    if (site.kind === "new-expression" && type.kind !== "class") continue;
    if (type.file === target.file && within(site.span, type.home)) continue;
    findings.push({
      rule_id: "c",
      file: target.file,
      message: `domain type ${type.name} built outside its ${type.kind} (${site.kind})`,
      line: site.span.start_line,
    });
  }
  const calls = facts.calls;
  for (const type of inspection.symbols.types.filter((entry) => entry.file === target.file))
    for (const method of type.methods.filter((entry) => POST_INIT.has(entry.name) && mutates(type, entry, calls)))
      findings.push({
        rule_id: "c",
        file: target.file,
        message: `domain type ${type.name} has a post-init method ${method.name} (c-post-init)`,
        line: method.span.start_line,
      });
  return findings;
}

// --- (d) getter call -----------------------------------------------------------------------------

function sameSpan(a: Span, b: Span): boolean {
  return within(a, b) && within(b, a);
}

/**
 * Whether the result of a getter call written in a use-case source reaches nothing but repository
 * ports: every call it is handed to unchanged is a method a port declares — an interface or a type
 * literal alias of the use-case layer named `…Repository` — called on a receiver stated to be that
 * port. What
 * cannot be proven so leaves the getter call a finding rather than undecided, as the Rust gate
 * leaves an unproven forwarding.
 */
function isRepositoryForwarding(
  inspection: TsInspection,
  target: TsTarget,
  facts: TypeScriptFileFacts,
  call: CallFact,
): boolean {
  if (target.pkg.assignment.layer !== "use-case" || !call.forwarded_to?.length) return false;
  return call.forwarded_to.every((span) => {
    const consumer = facts.calls.find((candidate) => sameSpan(candidate.span, span));
    if (consumer?.kind !== "method-call") return false;
    const stated = receiverType(facts, consumer);
    if (stated === undefined) return false;
    const port = resolveDeclaredType(inspection.packages, inspection.declarations, target.file, facts, stated);
    if (port.kind !== "found") return false;
    const { declaration, pkg } = port.entry;
    return (
      isPortDeclaration(declaration) &&
      pkg.assignment.layer === "use-case" &&
      declaration.name.endsWith("Repository") &&
      declaration.members.some((member) => member.kind === "method" && member.name === consumer.callee_text)
    );
  });
}

/** Getter calls of a checked source, reported from the layer of its package. */
export function ruleD(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const findings: FindingInput[] = [];
  const facts = factsOf(inspection, target.file);
  for (const call of facts.calls) {
    if (call.kind !== "method-call" || !inspection.symbols.getter_names.has(call.callee_text)) continue;
    if ((call.receiver_text ?? "").trim() === "this") continue;
    const line = call.span.start_line;
    const stated = receiverType(facts, call);
    if (stated === undefined) {
      inspection.undecided.add(
        target.file,
        line,
        `getter ${call.callee_text} called on ${call.receiver_text}, whose type is not stated`,
      );
      continue;
    }
    const resolved = resolveTypeName(inspection.packages, inspection.symbols, target.file, facts, stated);
    if (resolved.kind === "undecided") {
      inspection.undecided.add(target.file, line, `getter ${call.callee_text} receiver: ${resolved.reason}`);
      continue;
    }
    if (
      resolved.kind === "domain" &&
      resolved.type.methods.some((method) => method.name === call.callee_text && method.returns_state_only) &&
      !isRepositoryForwarding(inspection, target, facts, call)
    )
      findings.push({
        rule_id: "d",
        file: target.file,
        message: `getter ${call.callee_text} called from ${target.pkg.assignment.layer} layer (Tell, Don't Ask)`,
        line,
      });
  }
  return findings;
}

// --- domain packaging --------------------------------------------------------------------------

const TYPESCRIPT = SPELLINGS.typescript;

/** The modules of a domain package as its `src/` files lay them out, and the files that name none. */
function modulesOf(
  inspection: TsInspection,
  pkg: TsPackage,
): { modules: PackagingModule[]; problems: PackagingProblem[] } {
  const byPath = new Map<string, string[]>();
  const problems: PackagingProblem[] = [];
  const modules: PackagingModule[] = [];
  for (const absolute of packageSources(pkg)) {
    const file = posixRelative(inspection.packages.workspaceRoot, absolute);
    const parts = modulePathOf(pkg, absolute);
    const invalid = parts.find((part) => !TYPESCRIPT.isModuleSegment(part));
    if (invalid !== undefined) {
      problems.push({ file, reason: `${invalid} is not a module segment of a TypeScript package` });
      continue;
    }
    const key = parts.join("/");
    const files = byPath.get(key);
    if (files) {
      files.push(file);
      continue;
    }
    byPath.set(key, [file]);
    const technical = parts.map((part) => TYPESCRIPT.technicalSegment(part)).find((name) => name !== undefined);
    modules.push({ parts, file, ...(technical ? { technical } : {}) });
  }
  const collided = new Set<string>();
  for (const [key, files] of byPath) {
    if (files.length < 2) continue;
    collided.add(key);
    problems.push({
      file: files[0],
      reason: `${files.join(" and ")} both name the module path [${key.split("/").join(", ")}]`,
    });
  }
  return { modules: modules.filter((module) => !collided.has(module.parts.join("/"))), problems };
}

export function ruleDomainPackaging(inspection: TsInspection, pkg: TsPackage): FindingInput[] {
  const { modules, problems } = modulesOf(inspection, pkg);
  const mapping = inspection.mapping;
  const declared: DeclaredPackages =
    mapping.kind === "loaded" ? { kind: "loaded", packages: mapping.view.packages } : mapping;
  const technicalName = TYPESCRIPT.technicalPackage(pkg.name);
  return packagingFindings(
    {
      name: pkg.name,
      manifestFile: join(pkg.path, PACKAGE_MANIFEST),
      unit: "package",
      separator: "/",
      ...(technicalName ? { technicalName } : {}),
      modules,
      problems,
    },
    declared,
    relPath(inspection.run, mappingPathOf(inspection.run.modelDir)),
  );
}
