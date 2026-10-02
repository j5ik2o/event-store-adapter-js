/**
 * TypeScript rule evaluators of the use-case gate: an aggregate handed to `execute` (h) and one use
 * case calling another (i), each in the words the Rust use-case gate reports them in. Getter calls
 * (d) are in `evaluators.ts` and the dependency direction (g) in `edges.ts`; what these rules read
 * off a file's facts is in `file-facts.ts` and the binding to a model aggregate in `aggregate-binding.ts`.
 *
 * Nothing here infers a type. A parameter type or a receiver is what a declaration, an import or an
 * annotation spells, and what those do not decide is left undecided rather than passed.
 */

import type { FindingInput } from "../../shared/findings.ts";
import type { ParamFact, TypeScriptFileFacts } from "../../typescript/domain-facts/index.ts";
import { aggregateBinding } from "./aggregate-binding.ts";
import { enclosingClass, factsOf, receiverType } from "./file-facts.ts";
import { isNamedType, passedType, resolveDeclaredType, resolveTypeName, typeNamesIn } from "./symbols.ts";
import type { TsDomainType, TsInspection, TsTarget } from "./types.ts";

// --- (h) execute aggregate argument --------------------------------------------------------------

/** One `execute` a use-case source declares: a method of a class, or a function at the top of the file. */
interface ExecuteDeclaration {
  readonly params: readonly ParamFact[];
  readonly line: number;
}

function executesOf(facts: TypeScriptFileFacts): ExecuteDeclaration[] {
  return facts.declarations.flatMap((declaration): ExecuteDeclaration[] => {
    if (declaration.kind === "function")
      return declaration.name === "execute"
        ? [{ params: declaration.params ?? [], line: declaration.span.start_line }]
        : [];
    if (declaration.kind !== "class") return [];
    return declaration.members
      .filter((member) => member.kind === "method" && member.name === "execute")
      .map((member) => ({ params: member.params ?? [], line: member.span.start_line }));
  });
}

function isAggregate(inspection: TsInspection, type: TsDomainType): boolean {
  return aggregateBinding(inspection, type).aggregate !== undefined;
}

/**
 * The aggregate a parameter hands to `execute`, the type as it is written once the wrappings that
 * hand the same type over are removed; undefined when it hands none. A parameter that states no type,
 * or states one that holds an aggregate in any other way, is left undecided.
 */
function passedAggregate(
  inspection: TsInspection,
  target: TsTarget,
  facts: TypeScriptFileFacts,
  param: ParamFact,
  line: number,
): string | undefined {
  if (param.type_text === undefined) {
    inspection.undecided.add(target.file, line, `execute parameter ${param.name} states no type`);
    return undefined;
  }
  const passed = passedType(param.type_text);
  if (isNamedType(passed)) {
    const resolved = resolveTypeName(inspection.packages, inspection.symbols, target.file, facts, passed);
    if (resolved.kind === "undecided") {
      inspection.undecided.add(target.file, line, `execute parameter ${param.name}: ${resolved.reason}`);
      return undefined;
    }
    return resolved.kind === "domain" && isAggregate(inspection, resolved.type) ? passed : undefined;
  }
  for (const name of typeNamesIn(passed)) {
    const resolved = resolveTypeName(inspection.packages, inspection.symbols, target.file, facts, name);
    if (resolved.kind === "undecided") {
      inspection.undecided.add(target.file, line, `execute parameter ${param.name}: ${resolved.reason}`);
      return undefined;
    }
    if (resolved.kind === "domain" && isAggregate(inspection, resolved.type)) {
      inspection.undecided.add(
        target.file,
        line,
        `execute parameter ${param.name}: the type ${passed} names the aggregate ${name} but is not one it hands over`,
      );
      return undefined;
    }
  }
  return undefined;
}

/**
 * An `execute` — a class method, static and abstract ones included, or a function at the top of the
 * file — whose parameter hands over an aggregate. Only decided when the model is available, as the
 * aggregates are the model's.
 */
export function ruleH(inspection: TsInspection, target: TsTarget): FindingInput[] {
  if (inspection.model.status !== "available") return [];
  const facts = factsOf(inspection, target.file);
  const findings: FindingInput[] = [];
  for (const execute of executesOf(facts))
    for (const param of execute.params) {
      const aggregate = passedAggregate(inspection, target, facts, param, execute.line);
      if (aggregate !== undefined)
        findings.push({
          rule_id: "h",
          file: target.file,
          message: `execute receives aggregate ${aggregate} directly; pass ids and value objects`,
          line: execute.line,
        });
    }
  return findings;
}

// --- (use-case-name) a use case type ends with UseCase ----------------------------------------------

/**
 * A class of a use-case source that declares `execute` is a use case, and its name ends with
 * `UseCase` (`IssueInvoiceUseCase`). A use case written as a function at the top of the file has no
 * type to name.
 */
export function ruleUseCaseName(inspection: TsInspection, target: TsTarget): FindingInput[] {
  return factsOf(inspection, target.file)
    .declarations.filter(
      (declaration) =>
        declaration.kind === "class" &&
        !declaration.name.endsWith("UseCase") &&
        declaration.members.some((member) => member.kind === "method" && member.name === "execute"),
    )
    .map((declaration) => ({
      rule_id: "use-case-name",
      file: target.file,
      message: `use case ${declaration.name} is not named <Verb><Object>UseCase; name it ${declaration.name}UseCase`,
      line: declaration.span.start_line,
    }));
}

// --- (i) use case chaining -----------------------------------------------------------------------

/**
 * A call of `execute` on a use case of the use-case layer: a class that declares `execute`, reached
 * through a receiver stated to be it. A call on `this`, on a value of the calling class itself, or
 * on an interface — a port — is not one. A function `execute` called by name is none when the file
 * declares it as a function; otherwise — an import, or a class or variable of that name — which
 * function it calls is not decided here, so it is left undecided, as is a receiver whose type is not
 * stated.
 */
export function ruleI(inspection: TsInspection, target: TsTarget): FindingInput[] {
  const facts = factsOf(inspection, target.file);
  const findings: FindingInput[] = [];
  for (const call of facts.calls) {
    if (call.callee_text !== "execute") continue;
    const line = call.span.start_line;
    if (call.kind === "function-call") {
      // Only a function declaration of the file is known to be the one called; a class or a variable
      // of the same name (an arrow function among them) is not decided to be a function here.
      if (!facts.declarations.some((declaration) => declaration.name === "execute" && declaration.kind === "function"))
        inspection.undecided.add(target.file, line, "execute called by name, not declared as a function in this file");
      continue;
    }
    if (call.kind !== "method-call" || (call.receiver_text ?? "").trim() === "this") continue;
    const stated = receiverType(facts, call);
    if (stated === undefined) {
      inspection.undecided.add(target.file, line, `execute called on ${call.receiver_text}, whose type is not stated`);
      continue;
    }
    const resolved = resolveDeclaredType(inspection.packages, inspection.declarations, target.file, facts, stated);
    if (resolved.kind === "undecided") {
      inspection.undecided.add(target.file, line, `execute receiver: ${resolved.reason}`);
      continue;
    }
    if (resolved.kind !== "found") continue;
    const called = resolved.entry;
    const caller = enclosingClass(facts, call);
    if (called.file === target.file && caller?.name === called.declaration.name) continue;
    if (
      called.pkg.assignment.layer === "use-case" &&
      called.declaration.kind === "class" &&
      called.declaration.members.some((member) => member.kind === "method" && member.name === "execute")
    )
      findings.push({
        rule_id: "i",
        file: target.file,
        message: `use case calls ${called.file}#${called.declaration.name}.execute`,
        line,
      });
  }
  return findings;
}
