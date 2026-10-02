/**
 * State hiding (a) for both TypeScript representations, decided as the state-evidence inspection
 * decides it, on the facts rather than on a type checker.
 *
 * A class hides state only in `#` fields: `private`, `protected` and `readonly` are erased by the
 * compiler, so such a field is an own property anyone can read. Methods are operations, and static
 * members belong to the class object. An accessor, a base class or an implemented interface, an
 * ambient class, a `declare` or `abstract` member and a computed member name leave the state of the
 * class to what the running program does, so they are undecided.
 *
 * A companion hides state in the closure its factory builds. Its type literal carries exactly one
 * private brand — a computed key naming a non-exported top-level `const` of type `unique symbol`
 * created by the global `Symbol()` — and its instances are literals written inside its object. A
 * property of the type literal, or of an instance, is state anyone can read. A companion whose brand
 * or instances cannot be identified, or whose instance hides members or is made by an assertion,
 * is undecided.
 */

import type { FindingInput } from "../../shared/findings.ts";
import type { DeclarationFact, TypeScriptFileFacts } from "../../typescript/domain-facts/index.ts";
import { type CompanionPair, companionsOf, instancesOf, within } from "./symbols.ts";
import type { Undecided } from "./types.ts";

function publicField(file: string, type: string, member: string, line: number): FindingInput {
  return { rule_id: "a", file, message: `public field ${type}.${member} in domain layer`, line };
}

function classFindings(file: string, declaration: DeclarationFact, undecided: Undecided): FindingInput[] {
  const findings: FindingInput[] = [];
  const at = declaration.span.start_line;
  if (declaration.ambient) undecided.add(file, at, `ambient class ${declaration.name}`);
  for (const heritage of declaration.heritage ?? [])
    undecided.add(file, at, `class ${declaration.name} ${heritage.kind} ${heritage.type_text}`);
  for (const member of declaration.members) {
    if (member.static || member.kind === "constructor") continue;
    const line = member.span.start_line;
    const named = `${declaration.name}.${member.name}`;
    if (member.computed_key !== undefined) undecided.add(file, line, `computed member ${named}`);
    else if (member.kind === "get-accessor" || member.kind === "set-accessor")
      undecided.add(file, line, `accessor ${named}`);
    else if (member.ambient) undecided.add(file, line, `declared member ${named}`);
    else if (member.abstract) undecided.add(file, line, `abstract member ${named}`);
    else if (member.kind === "property" && member.visibility !== "private-name")
      findings.push(publicField(file, declaration.name, member.name, line));
  }
  return findings;
}

/**
 * The one identifier the type literal is keyed by, when it names a private brand; otherwise why
 * the brand cannot be identified.
 */
function brandOf(facts: TypeScriptFileFacts, pair: CompanionPair): { key: string } | { problem: string } {
  const keyed = pair.type.members.filter((member) => member.computed_key !== undefined);
  if (keyed.length !== 1) return { problem: `has ${keyed.length} computed keys rather than one brand` };
  const [brand] = keyed;
  const key = brand.computed_key as string;
  if (brand.kind !== "property" || brand.type_text !== "true") return { problem: `keys [${key}] to other than true` };
  const declared = facts.declarations.filter((entry) => entry.name === key);
  const constant = declared[0];
  if (declared.length !== 1 || constant.kind !== "variable" || constant.binding !== "const")
    return { problem: `is keyed by [${key}], which is not one top-level const` };
  const exported =
    constant.exported ||
    facts.exports.some((entry) => entry.specifier === undefined && entry.names.some((name) => name.local === key));
  if (exported) return { problem: `is keyed by [${key}], which is exported` };
  if (constant.type_text !== "unique symbol") return { problem: `is keyed by [${key}], which is not a unique symbol` };
  const created = constant.initializer;
  const shadowed =
    facts.declarations.some((entry) => entry.name === "Symbol") ||
    facts.imports.some((entry) => entry.bindings.some((binding) => binding.name === "Symbol"));
  if (
    created?.kind !== "call" ||
    created.callee_text !== "Symbol" ||
    created.arguments.length > 1 ||
    created.arguments.some((argument) => argument !== "string-literal") ||
    shadowed
  )
    return { problem: `is keyed by [${key}], which the global Symbol() does not create` };
  return { key };
}

function companionFindings(
  file: string,
  facts: TypeScriptFileFacts,
  pair: CompanionPair,
  undecided: Undecided,
): FindingInput[] {
  const name = pair.type.name;
  const brand = brandOf(facts, pair);
  if ("problem" in brand) {
    undecided.add(file, pair.type.span.start_line, `companion ${name} ${brand.problem}`);
    return [];
  }
  for (const assertion of facts.constructions)
    if (assertion.kind === "type-assertion" && assertion.type_text === name && within(assertion.span, pair.value.span))
      undecided.add(file, assertion.span.start_line, `companion ${name} asserts a value to its type`);
  const instances = instancesOf(facts, pair);
  if (instances.length === 0) undecided.add(file, pair.value.span.start_line, `companion ${name} writes no instance`);
  const findings: FindingInput[] = [];
  const declared = new Set<string>();
  for (const member of pair.type.members) {
    if (member.computed_key !== undefined) continue;
    const line = member.span.start_line;
    if (member.kind === "get-accessor" || member.kind === "set-accessor")
      undecided.add(file, line, `accessor ${name}.${member.name}`);
    else if (member.kind === "property") {
      declared.add(member.name);
      findings.push(publicField(file, name, member.name, line));
    }
  }
  const methods = pair.type.members.filter((member) => member.kind === "method").map((member) => member.name);
  for (const instance of instances) {
    const at = instance.span.start_line;
    if (instance.opaque) undecided.add(file, at, `an instance of companion ${name} hides members`);
    if (instance.form !== undefined && instance.form !== "annotation")
      undecided.add(file, at, `an instance of companion ${name} is typed by ${instance.form}`);
    const brands = instance.members.filter((member) => member.computed_key === brand.key);
    if (brands.length !== 1)
      undecided.add(file, at, `an instance of companion ${name} carries ${brands.length} brands`);
    for (const missing of methods.filter(
      (method) => !instance.members.some((member) => member.kind === "method" && member.name === method),
    ))
      undecided.add(file, at, `an instance of companion ${name} lacks the method ${missing}`);
    for (const member of instance.members) {
      if (member.computed_key === brand.key) continue;
      const line = member.span.start_line;
      if (member.computed_key !== undefined) undecided.add(file, line, `computed member ${name}.${member.name}`);
      else if (member.kind === "get-accessor" || member.kind === "set-accessor")
        undecided.add(file, line, `accessor ${name}.${member.name}`);
      else if (member.kind === "property" && !declared.has(member.name)) {
        declared.add(member.name);
        findings.push(publicField(file, name, member.name, line));
      }
    }
  }
  return findings;
}

/** The findings of rule (a) in one checked domain source; what it cannot decide goes to `undecided`. */
export function ruleA(file: string, facts: TypeScriptFileFacts, undecided: Undecided): FindingInput[] {
  return [
    ...facts.declarations.flatMap((declaration) =>
      declaration.kind === "class" ? classFindings(file, declaration, undecided) : [],
    ),
    ...companionsOf(facts).flatMap((pair) => companionFindings(file, facts, pair, undecided)),
  ];
}
