/** Domain summaries joined across explicitly resolved Rust declarations and impls. */
import type { MethodFact } from "../../rust/domain-facts/index.ts";
import { toKebab } from "../lists.ts";
import { bindAggregate, classifyMutation, declaredReplayEventNames } from "../mutations.ts";
import type { DomainSymbolTable, DomainTypeSymbol, ModelAvailability } from "../types.ts";
import type { RustAggregateMapping } from "./mapping.ts";
import type { LocatedMethod, RustProgram, RustType } from "./program.ts";

function isConstructor(method: MethodFact, typeName: string): boolean {
  if (method.receiver !== "none") return false;
  const ret = method.return_type_text ?? "";
  const outer = ret.replace(/^Result<|^Option<|^Box<|^Arc<|^Rc</, "").trim();
  return (
    ret === "Self" ||
    ret === typeName ||
    /^(Result|Option)<.*\bSelf\b/.test(ret) ||
    ret.includes("Self") ||
    outer === typeName
  );
}

function matchesLocation(type: RustType, mapping: RustAggregateMapping): boolean {
  return mapping.crate.replace(/-/g, "_") === type.crate && mapping.module.join("::") === type.module.join("::");
}

function aggregateFor(
  type: RustType,
  program: RustProgram,
  model: ModelAvailability,
  mappings: readonly RustAggregateMapping[],
): { aggregate?: string; ambiguous: boolean } {
  const sameNames = program.types.filter((candidate) => candidate.layer === "domain" && candidate.name === type.name);
  return bindAggregate(
    type,
    sameNames.length,
    model,
    mappings,
    (mapping) => matchesLocation(type, mapping),
    program.notes,
  );
}

export function buildSymbolTable(
  program: RustProgram,
  model: ModelAvailability,
  mappings: readonly RustAggregateMapping[],
): DomainSymbolTable {
  const types: DomainTypeSymbol[] = [];
  const getterNames = new Set<string>();
  const typeNames = new Set<string>();
  const constructorsByType = new Map<string, Set<string>>();
  for (const type of program.types) {
    if (type.layer !== "domain") continue;
    if (type.kind === "trait") continue;
    const binding = aggregateFor(type, program, model, mappings);
    const aggregate = binding.aggregate;
    const inherent = type.methods.filter((entry) => !entry.trait);
    const constructors = inherent
      .filter((entry) => isConstructor(entry.method, type.name))
      .map((entry) => entry.method.name);
    const mutators = type.methods
      .filter((entry) => entry.method.receiver === "mut-self")
      .map((entry) =>
        classifyMutation(
          { name: entry.method.name, file: entry.file, line: entry.method.line },
          aggregate,
          model,
          isReplay(entry, type, aggregate, model, program, mappings),
          binding.ambiguous,
        ),
      );
    const defaults = type.methods
      .filter((entry) => entry.trait === "Default" || entry.trait?.endsWith("::Default"))
      .map((entry) => ({ file: entry.file, line: entry.method.line }));
    if (type.derives.includes("Default")) defaults.push({ file: type.file, line: 1 });
    types.push({
      key: type.key,
      type_name: type.name,
      crate_name: type.crate.replace(/_/g, "-"),
      file: type.file,
      kind: type.kind,
      aggregate_slug: aggregate?.slice("aggregate.".length) ?? toKebab(type.name),
      aggregate_ref: aggregate,
      constructors,
      mutators,
      has_default: defaults.length > 0,
      defaults,
      non_private_field_lines: type.fields.filter((field) => field.visibility !== "private").map((field) => field.line),
      field_type_texts: type.fields.map((field) => field.type_text),
    });
    for (const entry of inherent) if (entry.method.returns_field_only) getterNames.add(entry.method.name);
    typeNames.add(type.name);
    const known = constructorsByType.get(type.name) ?? new Set<string>();
    for (const factory of constructors) known.add(factory);
    constructorsByType.set(type.name, known);
  }
  types.sort((a, b) => a.key.localeCompare(b.key, "en"));
  return {
    crates: [...new Set(types.map((type) => type.crate_name))].sort(),
    types,
    getter_names: getterNames,
    type_names: typeNames,
    constructors_by_type: constructorsByType,
    file_count: new Set(types.map((type) => type.file)).size,
  };
}

function isReplay(
  entry: LocatedMethod,
  type: RustType,
  aggregate: string | undefined,
  model: ModelAvailability,
  program: RustProgram,
  mappings: readonly RustAggregateMapping[],
): boolean {
  const eventNames = declaredReplayEventNames(
    entry.method.name,
    entry.method.params.length,
    aggregate,
    model,
    mappings,
    (mapping) => matchesLocation(type, mapping),
  );
  if (!eventNames) return false;
  const eventType = program.resolveType(entry.file, entry.module, entry.method.params[0].type_text);
  return (
    eventType !== undefined &&
    eventType.kind !== "trait" &&
    eventType.layer === "domain" &&
    eventType.crate === type.crate &&
    program.types.filter(
      (candidate) =>
        candidate.layer === "domain" && candidate.crate === eventType.crate && candidate.name === eventType.name,
    ).length === 1 &&
    eventNames.includes(eventType.name)
  );
}
