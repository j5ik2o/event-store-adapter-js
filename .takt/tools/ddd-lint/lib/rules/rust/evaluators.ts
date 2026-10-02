/**
 * Rust rule evaluators. Each evaluator reads the syntax facts and
 * the workspace context and explicit declaration bindings. They do not perform
 * compiler inference, trait solving or macro expansion.
 */

import type { CallFact, ParamFact, RustFileFacts, Span } from "../../rust/domain-facts/index.ts";
import { finding } from "../../project/context.ts";
import { operationOwner } from "../operation-owner.ts";
import type { FindingInput } from "../../shared/findings.ts";
import { containsMediaWord, toPascal } from "../lists.ts";
import type { DomainTypeSymbol, InspectionContext, InspectionTarget } from "../types.ts";
import { evaluateDomainPackaging } from "./packaging.ts";
import { within as withinSpan } from "./program.ts";

function within(span: Span, outer: Span): boolean {
  return (
    span.start_line >= outer.start_line &&
    (span.end_line < outer.end_line || (span.end_line === outer.end_line && span.end_col <= outer.end_col))
  );
}

function stripType(typeText: string): string {
  let text = typeText.trim();
  text = text.replace(/^&(?:'\w+)?\s*(?:mut\s+)?/, "");
  let changed = true;
  while (changed) {
    changed = false;
    const match = /^(Box|Arc|Rc|Option|Vec)\s*<(.+)>$/.exec(text);
    if (match) {
      text = match[2].trim();
      changed = true;
    }
  }
  return text;
}

function domainTypeSymbol(symbols: InspectionContext["symbols"], typeName: string): DomainTypeSymbol[] {
  return symbols.types.filter((symbol) => symbol.type_name === typeName);
}

/**
 * What the extractor reported for one inspected file. An inspected file always has a record; its
 * absence means the extractor could not read the file, which is not the same answer as "it
 * declares nothing".
 */
function declarationsOf(context: InspectionContext, file: string): RustFileFacts {
  const declared = context.program.facts.files.get(file);
  if (!declared) throw new Error(`the native domain facts carry no declarations for ${file}`);
  return declared;
}

// --- (a) public field -------------------------------------------------------
function ruleA(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const file = target.file;
  return declarationsOf(context, file).publicMembers.map((member) =>
    finding("a", file, `public field ${member.typeName}.${member.name} in domain layer`, member.line),
  );
}

// --- (b) undeclared mutation ------------------------------------------------
/**
 * A `&mut self` method of an aggregate root is a declared command. The values, Entities and
 * collections inside the aggregate change through their own `&mut self` methods, which the root's
 * commands call; they are not commands of their own.
 */
function ruleB(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const out: FindingInput[] = [];
  for (const symbol of context.symbols.types) {
    if (symbol.aggregate_ref === undefined) continue;
    for (const mutator of symbol.mutators) {
      if (mutator.file !== target.file) continue;
      if (mutator.classification === "undeclared") {
        out.push(
          finding(
            "b",
            target.file,
            `mutating method ${symbol.type_name}::${mutator.method_name} is not declared as command.${symbol.aggregate_slug}.${mutator.command_slug}`,
            mutator.line,
          ),
        );
      }
    }
  }
  return out;
}

// --- (operation) every mapped operation is a method returning the mapped Result ------------------

function withoutSpaces(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * Every operation the mapping places on a type of this file is an inherent method of that type: an
 * associated function for a factory rule, a `&mut self` method for a command. Its stated return type
 * is `Result<success, error>`: the mapped success type (`Self` or the type for a factory rule) and the
 * mapped error type.
 */
function ruleOperation(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file || context.rustMapping.kind !== "loaded") return [];
  const file = target.file;
  const out: FindingInput[] = [];
  for (const type of context.program.types.filter((entry) => entry.file === file && entry.kind !== "trait")) {
    // The operations whose method this type owns: the aggregate's own, where the mapping places the
    // aggregate at this type, and the factories of the other elements this type is.
    const owned = context.rustMapping.view.aggregates
      .filter((entry) => entry.crate.replace(/-/g, "_") === type.crate.replace(/-/g, "_"))
      .flatMap((entry) =>
        entry.operations.filter(
          (operation) =>
            operationOwner(context.model, operation.operation_ref, entry.type) === type.name &&
            (entry.type !== type.name || entry.module.join("::") === type.module.join("::")),
        ),
      );
    if (owned.length === 0) continue;
    const line = declarationsOf(context, file).types.find((entry) => entry.name === type.name)?.line;
    for (const operation of owned) {
      const factory = operation.operation_ref.startsWith("factory.");
      const methods = type.methods.filter((entry) => !entry.trait && entry.method.name === operation.method);
      if (methods.length === 0) {
        out.push(finding("operation", file, `${type.name} has no ${factory ? "associated function" : "command method"} ${operation.method} for ${operation.operation_ref}`, line));
        continue;
      }
      const successes = factory ? [operation.success_type ?? type.name, "Self"] : [operation.success_type ?? type.name];
      for (const { method } of methods) {
        const problems: string[] = [];
        if (!factory && method.receiver !== "mut-self") problems.push("does not take &mut self");
        const stated = method.return_type_text;
        const accepted = successes.map((success) => `Result<${success},${operation.error_type}>`);
        if (stated === undefined || !accepted.includes(withoutSpaces(stated)))
          problems.push(`returns ${stated ?? "()"}, not Result<${successes[0]}, ${operation.error_type}>`);
        if (problems.length > 0)
          out.push(
            finding("operation", file, `${type.name}::${method.name} (${operation.operation_ref}) ${problems.join(" and ")}`, method.line),
          );
      }
    }
  }
  return out;
}

// --- (in-place) a domain value changes in place instead of being copied ----------------------------

/** The operator traits whose method hands back a new value; each has an `*Assign` form. */
const COPYING_OPERATORS = new Set(["Add", "Sub", "Mul", "Div", "Rem"]);

/** The top-level generic arguments of `text` when it is `name<...>`. */
function genericArguments(text: string, name: string): string[] | undefined {
  if (!text.startsWith(`${name}<`) || !text.endsWith(">")) return undefined;
  const inner = text.slice(name.length + 1, -1);
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (char === "<" || char === "(" || char === "[") depth++;
    else if (char === ">" || char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      found.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  found.push(inner.slice(start));
  return found;
}

/** What a method hands back on success: `Result<T, E>` and `Option<T>` read as `T`. */
function producedType(returnTypeText: string): string {
  let text = withoutSpaces(returnTypeText);
  for (;;) {
    const found = genericArguments(text, "Result") ?? genericArguments(text, "Option");
    if (found === undefined) return text;
    text = found[0];
  }
}

/**
 * A domain type changes its own state through `&mut self`. A method taking `&self` or `self` that hands back a new
 * instance of its own type, or a changed copy of a value it took by value, is the copy-on-change style
 * Rust code does not use; so are the operator traits whose method returns a new value.
 */
function ruleInPlace(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const file = target.file;
  const out: FindingInput[] = [];
  for (const type of context.program.types.filter((entry) => entry.kind !== "trait")) {
    for (const { method, trait, file: methodFile } of type.methods) {
      if (methodFile !== file) continue;
      const externalMutable = method.params.find(
        (param) => param.name !== "self" && /^&\s*(?:'[^\s]+\s*)?mut\s+/.test(param.type_text.trim()),
      );
      if (externalMutable !== undefined)
        out.push(
          finding(
            "in-place",
            file,
            `${type.name}::${method.name} changes a &mut argument it received; change the value itself through &mut self instead`,
            method.line,
          ),
        );
      if (trait !== undefined) {
        const operator = trait.replace(/<.*$/s, "").split("::").pop()?.trim() ?? "";
        if (COPYING_OPERATORS.has(operator))
          out.push(
            finding("in-place", file, `${type.name} implements ${operator}, which returns a new value; implement ${operator}Assign and change the value in place`, method.line),
          );
        continue;
      }
      if (method.receiver !== "ref-self" && method.receiver !== "self") continue;
      if (method.return_type_text === undefined) continue;
      const produced = producedType(method.return_type_text);
      const copied = method.params.find((param) => withoutSpaces(param.type_text) === produced);
      if (produced === "Self" || produced === type.name)
        out.push(
          finding("in-place", file, `${type.name}::${method.name} returns a new ${type.name} instead of changing it; take &mut self and change it in place`, method.line),
        );
      else if (copied !== undefined)
        out.push(
          finding(
            "in-place",
            file,
            `${type.name}::${method.name} returns a changed copy of ${copied.name}; make that value the receiver and change it through &mut self instead`,
            method.line,
          ),
        );
    }
  }
  return out;
}

// --- (collection) a domain type holds no bare collection beside other state ------------------------

const BARE_COLLECTION_RS = /^(?:std::collections::)?(?:Vec|VecDeque|HashSet|HashMap|BTreeSet|BTreeMap|BinaryHeap)\s*<|^\[|^Box\s*<\s*\[/;

/**
 * A domain struct whose state holds a collection beside other fields wraps it in a first-class
 * collection type. A struct whose one field is a collection is the first-class collection itself.
 */
function ruleCollection(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const file = target.file;
  const out: FindingInput[] = [];
  for (const type of context.program.types.filter((entry) => entry.file === file && entry.kind === "struct")) {
    if (type.fields.length < 2) continue;
    for (const field of type.fields) {
      if (!BARE_COLLECTION_RS.test(field.type_text.trim())) continue;
      out.push(
        finding(
          "collection",
          file,
          `${type.name} holds ${field.name} as a bare collection (${field.type_text.trim()}); wrap it in a first-class collection type`,
          field.line,
        ),
      );
    }
  }
  return out;
}

// --- (c) incomplete construction --------------------------------------------
function ruleC(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const out: FindingInput[] = [];
  const declared = declarationsOf(context, target.file);
  const inherentSpans = new Map<string, Span[]>();
  for (const block of declared.impls) {
    if (block.trait_text !== undefined) continue;
    const list = inherentSpans.get(block.target_type_text) ?? [];
    list.push(block.span);
    inherentSpans.set(block.target_type_text, list);
  }
  for (const site of declared.constructions) {
    if (!context.symbols.type_names.has(site.type_text)) continue;
    if (site.kind === "struct-literal" || site.kind === "update-syntax") {
      const spans = inherentSpans.get(site.type_text) ?? [];
      if (!spans.some((span) => within(site.span, span))) {
        out.push(
          finding(
            "c",
            target.file,
            `domain type ${site.type_text} built outside its inherent impl (${site.kind})`,
            site.span.start_line,
          ),
        );
      }
    } else if (site.kind === "default-call") {
      out.push(
        finding("c", target.file, `domain type ${site.type_text} built via Default (c-default)`, site.span.start_line),
      );
    }
  }
  for (const symbol of context.symbols.types) {
    for (const location of symbol.defaults) {
      if (location.file !== target.file) continue;
      out.push(
        finding(
          "c",
          target.file,
          `domain type ${symbol.type_name} has a Default construction path (c-default)`,
          location.line,
        ),
      );
    }
    for (const mutator of symbol.mutators) {
      if (mutator.file !== target.file) continue;
      if (mutator.classification === "post-init") {
        out.push(
          finding(
            "c",
            target.file,
            `domain type ${symbol.type_name} has a post-init method ${mutator.method_name} (c-post-init)`,
            mutator.line,
          ),
        );
      }
    }
  }
  return out;
}

// --- (d) getter call --------------------------------------------------------
function isRepositoryArgument(
  file: string,
  call: CallFact,
  callSites: readonly CallFact[],
  target: InspectionTarget,
  context: InspectionContext,
): boolean {
  if (target.classification.effective_layer !== "use-case" || !call.forwarded_argument_calls.length || !target.file) {
    return false;
  }
  return call.forwarded_argument_calls.every((span) => {
    const consumer = callSites.find(
      (candidate) => withinSpan(candidate.span, span) && withinSpan(span, candidate.span),
    );
    if (consumer?.kind !== "method-call") return false;
    const port = context.program.receiver(file, consumer);
    if (!port) {
      context.program.notes.add(
        `syntax.unresolved: ${file}:${consumer.span.start_line} repository receiver; rule d exception not proven`,
      );
      return false;
    }
    if (port.kind !== "trait" || port.layer !== "use-case" || !port.name.endsWith("Repository")) {
      return false;
    }
    return port.traitMethods.includes(consumer.callee_text);
  });
}

function ruleD(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const getterNames = context.symbols.getter_names;
  const out: FindingInput[] = [];
  const callSites = declarationsOf(context, target.file).calls;
  for (const call of callSites) {
    if (call.kind !== "method-call") continue;
    const receiver = (call.receiver_text ?? "").replace(/\s+/g, " ").trim();
    if (["self", "&self", "&mut self", "Self", "&mut  self"].includes(receiver)) continue;
    if (!getterNames.has(call.callee_text)) continue;
    const type = context.program.receiver(target.file, call);
    if (!type) {
      context.program.notes.add(
        `syntax.unresolved: ${target.file}:${call.span.start_line} getter receiver; rule d not evaluated`,
      );
      continue;
    }
    if (
      type.layer === "domain" &&
      type.methods.some((entry) => entry.method.name === call.callee_text && entry.method.returns_field_only)
    ) {
      if (isRepositoryArgument(target.file, call, callSites, target, context)) continue;
      out.push(
        finding(
          "d",
          target.file,
          `getter ${call.callee_text} called from ${target.classification.effective_layer} layer (Tell, Don't Ask)`,
          call.span.start_line,
        ),
      );
    }
  }
  return out;
}

// --- (g) forbidden dependency / external I/O --------------------------------
function ruleG(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  const crate = target.crate_name;
  if (!crate) return [];
  return context.edges
    .filter(
      (edge) => edge.from_crate === crate && (edge.verdict === "layer-forbidden" || edge.verdict === "external-io"),
    )
    .map((edge) =>
      finding(
        "g",
        edge.file,
        `dependency direction ${edge.from_crate} -> ${edge.to_crate} (${edge.verdict})`,
        edge.line,
      ),
    );
}

// --- (h) execute aggregate argument -----------------------------------------
function ruleH(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  if (context.model.status !== "available") return [];
  const out: FindingInput[] = [];
  const file = context.program.files.get(target.file);
  if (!file) return [];
  const check = (name: string, params: readonly ParamFact[], line: number, module: readonly string[]) => {
    if (name !== "execute") return;
    for (const param of params) {
      const stripped = stripType(param.type_text);
      const type = context.program.resolveType(file.file, [...file.module, ...module], param.type_text);
      if (!type && !/^(bool|str|String|[uif](8|16|32|64|128)|[ui]size|\(\))$/.test(stripped)) {
        context.program.notes.add(
          `syntax.unresolved: ${file.file}:${line} parameter ${param.type_text}; rule h not evaluated`,
        );
      }
      if (
        type &&
        context.symbols.types.some((symbol) => symbol.key === type.key && symbol.aggregate_ref !== undefined)
      ) {
        out.push(
          finding("h", file.file, `execute receives aggregate ${stripped} directly; pass ids and value objects`, line),
        );
      }
    }
  };
  const declared = declarationsOf(context, target.file);
  for (const block of declared.impls) {
    for (const method of block.methods) check(method.name, method.params, method.line, block.module);
  }
  for (const fn of declared.functions) check(fn.name, fn.params, fn.line, fn.module);
  return out;
}

// --- (use-case-name) a use case type ends with UseCase ----------------------
// The type an impl block with `execute` belongs to is a use case, and its name ends with `UseCase`
// (`IssueInvoiceUseCase`). A free `fn execute` has no type to name.
function ruleUseCaseName(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const file = target.file;
  const out: FindingInput[] = [];
  const reported = new Set<string>();
  for (const block of declarationsOf(context, file).impls) {
    if (!block.methods.some((method) => method.name === "execute")) continue;
    const name = block.target_type_text.replace(/<[\s\S]*$/, "").trim().split("::").pop() ?? "";
    if (name === "" || name.endsWith("UseCase") || reported.has(name)) continue;
    reported.add(name);
    out.push(
      finding(
        "use-case-name",
        file,
        `use case ${name} is not named <Verb><Object>UseCase; name it ${name}UseCase`,
        block.span.start_line,
      ),
    );
  }
  return out;
}

// --- (i) use case chaining --------------------------------------------------
function ruleI(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const out: FindingInput[] = [];
  for (const call of declarationsOf(context, target.file).calls) {
    if (call.callee_text !== "execute" && !call.callee_text.endsWith("::execute")) continue;
    if (["self", "Self"].includes((call.receiver_text ?? "").trim())) continue;
    const file = context.program.files.get(target.file);
    if (!file) continue;
    const type =
      call.kind === "method-call"
        ? context.program.receiver(target.file, call)
        : context.program.resolveType(target.file, [...file.module, ...call.module], call.callee_text.slice(0, -9));
    if (!type) {
      context.program.notes.add(
        `syntax.unresolved: ${target.file}:${call.span.start_line} execute receiver; rule i not evaluated`,
      );
      continue;
    }
    const caller = file.impls.find((block) => withinSpan(call.span, block.span));
    const callerType =
      caller && context.program.resolveType(target.file, [...file.module, ...caller.module], caller.target_type_text);
    if (callerType?.key === type.key) continue;
    if (
      type.layer === "use-case" &&
      type.kind !== "trait" &&
      type.methods.some((entry) => !entry.trait && entry.method.name === "execute")
    ) {
      out.push(finding("i", target.file, `use case calls ${type.key}::execute`, call.span.start_line));
    }
  }
  return out;
}

// --- (k) cross-side reference -----------------------------------------------
function ruleK(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  const crate = target.crate_name;
  if (!crate) return [];
  return context.edges
    .filter((edge) => edge.from_crate === crate && edge.verdict === "cross-side")
    .map((edge) => finding("k", edge.file, `cross-side reference ${edge.from_crate} -> ${edge.to_crate}`, edge.line));
}

// --- (l) query side domain / repository reference ---------------------------
function ruleL(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  if (target.classification.cqrs_side !== "query") return [];
  const out: FindingInput[] = [];
  const isDomainOrRepo = (name: string) => context.symbols.type_names.has(name) || name.endsWith("Repository");
  for (const use of declarationsOf(context, target.file).uses) {
    const last =
      use.path_text
        .split("::")
        .pop()
        ?.replace(/[{}\s*]/g, "") ?? "";
    if (isDomainOrRepo(last)) {
      out.push(finding("l", target.file, `query side references domain type / repository port ${last}`, use.line));
    }
  }
  for (const symbol of context.symbols.types) {
    if (symbol.file !== target.file) continue;
    for (const typeText of symbol.field_type_texts) {
      const stripped = stripType(typeText);
      if (isDomainOrRepo(stripped)) {
        out.push(finding("l", target.file, `query side references domain type / repository port ${stripped}`));
      }
    }
  }
  return out;
}

// --- (m) repository naming --------------------------------------------------
function ruleM(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const out: FindingInput[] = [];
  const aggregates = new Set<string>();
  if (context.model.status === "available" && context.model.index) {
    for (const element of context.model.index.elements("aggregate")) {
      aggregates.add(toPascal(element.id.segments[0]));
    }
  }
  if (aggregates.size === 0) {
    for (const name of context.symbols.type_names) aggregates.add(name);
  }
  const matchesAggregate = (name: string): boolean => {
    if (!name.endsWith("Repository")) return true;
    const stem = name.slice(0, -"Repository".length);
    return [...aggregates].some((aggregate) => stem === aggregate || stem.endsWith(aggregate));
  };
  const declared = declarationsOf(context, target.file);
  // Ports (traits): <Aggregate>Repository, free of a storage medium.
  for (const trait of declared.traits) {
    if (!trait.name.endsWith("Repository")) continue;
    if (!matchesAggregate(trait.name)) {
      out.push(finding("m", target.file, `repository port ${trait.name} is not <Aggregate>Repository`, trait.line));
    }
    if (containsMediaWord(trait.name)) {
      out.push(finding("m", target.file, `repository port ${trait.name} names a storage medium`, trait.line));
    }
  }
  // Implementations (structs): a medium prefix is allowed; the trait carries the
  // naming contract.
  for (const decl of declared.types) {
    if (decl.name.endsWith("Repository") && !matchesAggregate(decl.name)) {
      out.push(finding("m", target.file, `repository type ${decl.name} is not <Aggregate>Repository`, decl.line));
    }
  }
  return out;
}

// --- (port-placement) a port belongs to the use-case layer -----------------
// A repository port (a trait named `…Repository`) declared in a domain crate. The use case loads
// and stores through its ports; the domain never declares, holds or calls one.
function rulePortPlacement(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const file = target.file;
  return declarationsOf(context, file)
    .traits.filter((trait) => trait.name.endsWith("Repository"))
    .map((trait) =>
      finding(
        "port-placement",
        file,
        `repository port ${trait.name} is declared in the domain layer; declare it in the use-case layer`,
        trait.line,
      ),
    );
}

// --- (n) restoration bypass -------------------------------------------------
function ruleN(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  if (!target.file) return [];
  const out: FindingInput[] = [];
  for (const site of declarationsOf(context, target.file).constructions) {
    if (!context.symbols.type_names.has(site.type_text)) continue;
    if (site.kind === "struct-literal" || site.kind === "update-syntax" || site.kind === "default-call") {
      out.push(
        finding(
          "n",
          target.file,
          `adapter constructs ${site.type_text} via ${site.kind} instead of a full constructor`,
          site.span.start_line,
        ),
      );
      continue;
    }
    if (site.kind === "associated-call") {
      const constructors = context.symbols.constructors_by_type.get(site.type_text);
      if (!constructors || !site.callee_text || !constructors.has(site.callee_text)) {
        out.push(
          finding(
            "n",
            target.file,
            `adapter constructs ${site.type_text} via ${site.callee_text ?? "an unknown function"} instead of a full constructor`,
            site.span.start_line,
          ),
        );
      }
    }
  }
  void domainTypeSymbol;
  return out;
}

export const PER_FILE_EVALUATORS: Record<
  string,
  (target: InspectionTarget, context: InspectionContext) => FindingInput[]
> = {
  a: ruleA,
  b: ruleB,
  operation: ruleOperation,
  "in-place": ruleInPlace,
  collection: ruleCollection,
  "port-placement": rulePortPlacement,
  c: ruleC,
  d: ruleD,
  h: ruleH,
  i: ruleI,
  "use-case-name": ruleUseCaseName,
  l: ruleL,
  m: ruleM,
  n: ruleN,
};

export const CONTEXT_EVALUATORS: Record<
  string,
  (target: InspectionTarget, context: InspectionContext) => FindingInput[]
> = {
  g: ruleG,
  k: ruleK,
  "domain-packaging": evaluateDomainPackaging,
};
