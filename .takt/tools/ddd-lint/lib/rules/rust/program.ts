/** Explicit Rust declarations and bindings; no inference, macro expansion or trait solving. */
import { inspectModules, isRustSource, type ModuleInventory } from "../../packaging/rust-modules.ts";
import type { CallFact, DomainFactSet, FieldFact, ImplFact, MethodFact, Span } from "../../rust/domain-facts/index.ts";
import type { CrateLayerAssignment, Layer } from "../../workspace/resolver.ts";

/** The layers whose crates make up the program the Rust rules read. */
export const PROGRAM_LAYERS: readonly Layer[] = ["domain", "use-case", "interface-adapter", "rmu"];

export interface LocatedMethod {
  file: string;
  module: string[];
  method: MethodFact;
  trait?: string;
}
export interface RustType {
  key: string;
  name: string;
  crate: string;
  layer: Layer;
  file: string;
  module: string[];
  kind: "struct" | "enum" | "trait";
  fields: readonly FieldFact[];
  derives: readonly string[];
  /** The names a trait declares; empty for a struct or an enum, which declare none. */
  traitMethods: readonly string[];
  methods: LocatedMethod[];
}
export interface RustFile {
  file: string;
  crate: string;
  module: string[];
  impls: readonly ImplFact[];
  localImports: boolean;
}
interface Alias {
  key: string;
  file: string;
  module: string[];
  target: string;
  generic: boolean;
}

export interface RustProgram {
  moduleInventories: Map<string, ModuleInventory>;
  files: Map<string, RustFile>;
  types: RustType[];
  notes: Set<string>;
  /** The native facts this program was built from, keyed by workspace-relative file. */
  facts: DomainFactSet;
  resolveType(file: string, module: string[], text: string): RustType | undefined;
  receiver(file: string, call: CallFact): RustType | undefined;
}

/** One crate of the program, with the module walk that found its sources. */
export interface RustCrateSources {
  assignment: CrateLayerAssignment;
  inventory: ModuleInventory;
}

export interface RustSourceInventory {
  crates: RustCrateSources[];
  /** Every crate the workspace assigns a layer to; a path starting with one is crate-qualified. */
  workspaceCrates: Set<string>;
}

/**
 * Walks each program crate's modules over the declarations the extractor already answered for.
 * Discovery is separate from `buildProgram` because the walk decides which file to open next from
 * the declarations of the one it is on, so the batch has to be answered before either can run.
 */
export function collectRustSources(
  facts: DomainFactSet,
  root: string,
  assignments: readonly CrateLayerAssignment[],
): RustSourceInventory {
  const crates: RustCrateSources[] = [];
  for (const assignment of assignments) {
    if (!PROGRAM_LAYERS.includes(assignment.layer)) continue;
    // The batch behind `facts` was gathered by `rustSourcesUnder`, so the walk is held to the same
    // rule: a declaration naming a file that enumeration leaves out is reported where it is written
    // rather than followed and then reported as one the extractor could not read.
    crates.push({
      assignment,
      inventory: inspectModules(facts.files, root, assignment, { covers: isRustSource }),
    });
  }
  const workspaceCrates = new Set(assignments.map((entry) => entry.crate_name.replace(/-/g, "_")));
  return { crates, workspaceCrates };
}

export function within(inner: Span, outer: Span): boolean {
  return (
    (inner.start_line > outer.start_line ||
      (inner.start_line === outer.start_line && inner.start_col >= outer.start_col)) &&
    (inner.end_line < outer.end_line || (inner.end_line === outer.end_line && inner.end_col <= outer.end_col))
  );
}

function importNames(text: string, prefix = ""): { name: string; target: string }[] {
  const start = text.indexOf("{");
  if (start !== -1) {
    const path = prefix + text.slice(0, start);
    const body = text.slice(start + 1, text.lastIndexOf("}"));
    const entries: string[] = [];
    let depth = 0;
    let beginning = 0;
    for (let i = 0; i <= body.length; i++) {
      if (body[i] === "{") depth++;
      if (body[i] === "}") depth--;
      if (i === body.length || (body[i] === "," && depth === 0)) {
        entries.push(body.slice(beginning, i).trim());
        beginning = i + 1;
      }
    }
    return entries.filter(Boolean).flatMap((entry) => importNames(entry, path));
  }
  const [path, alias] = text.trim().split(/\s+as\s+/);
  if (!path || path.includes("*")) return [];
  const target = (prefix + path).replace(/::self$/, "");
  return [{ name: alias ?? target.split("::").at(-1) ?? "", target }];
}

function bareType(text: string): string {
  return text
    .trim()
    .replace(/^&\s*(?:'\w+\s*)?(?:mut\s+)?/, "")
    .replace(/^(impl|dyn)\s+/, "")
    .trim();
}

export function buildProgram(sources: RustSourceInventory, facts: DomainFactSet): RustProgram {
  const files = new Map<string, RustFile>();
  const types: RustType[] = [];
  const aliases: Alias[] = [];
  const notes = new Set<string>();
  const moduleInventories = new Map<string, ModuleInventory>();
  for (const { assignment, inventory } of sources.crates) {
    const crate = assignment.crate_name.replace(/-/g, "_");
    moduleInventories.set(assignment.crate_name, inventory);
    for (const issue of inventory.problems) notes.add(`syntax.unresolved: ${issue.file}:${issue.line} ${issue.reason}`);
    for (const entry of inventory.sources) {
      const { file } = entry;
      if (files.has(file)) continue;
      const namespaces = new Set(
        inventory.sources.filter((candidate) => candidate.file === file).map((candidate) => candidate.parts.join("::")),
      );
      if (namespaces.size > 1) {
        notes.add(`syntax.unresolved: ${file} is used in multiple module namespaces`);
        continue;
      }
      const module = entry.parts;
      // The batch is keyed by the file the walk read, which is not the path it reached that file by
      // when a declaration names a symbolic link.
      const declared = facts.files.get(entry.decidedFrom);
      // The walk does list a source it could not read — it reports the problem and keeps the entry —
      // so this is unreachable only because `requireDecisionBase` runs first and sends every crate
      // source the extractor did not answer for to the tool-unavailable terminal. Reaching it means
      // that guard and this walk disagree about which files the batch covered.
      if (!declared) throw new Error(`the native facts carry no declarations for ${entry.decidedFrom}`);
      files.set(file, {
        file,
        crate,
        module,
        impls: declared.impls,
        localImports: declared.uses.some((entry) => entry.local),
      });
      const located = (scope: readonly string[], name: string) => ({
        key: [crate, ...scope, name].join("::"),
        name,
        crate,
        layer: assignment.layer,
        file,
        module: [...scope],
      });
      for (const decl of declared.types) {
        types.push({
          ...located([...module, ...decl.module], decl.name),
          kind: decl.kind,
          fields: decl.fields,
          derives: decl.derives,
          traitMethods: [],
          methods: [],
        });
      }
      for (const decl of declared.traits) {
        types.push({
          ...located([...module, ...decl.module], decl.name),
          kind: "trait",
          fields: [],
          derives: [],
          traitMethods: decl.methods,
          methods: [],
        });
      }
      for (const entry of declared.uses.filter((item) => !item.local)) {
        const scope = [...module, ...entry.module];
        for (const binding of importNames(entry.path_text)) {
          aliases.push({
            key: [crate, ...scope, binding.name].join("::"),
            file,
            module: scope,
            target: binding.target,
            generic: false,
          });
        }
      }
      for (const entry of declared.aliases.filter((item) => !item.local)) {
        const scope = [...module, ...entry.module];
        aliases.push({
          key: [crate, ...scope, entry.name].join("::"),
          file,
          module: scope,
          target: entry.type_text,
          generic: entry.generic,
        });
      }
    }
  }
  const crates = sources.workspaceCrates;
  function lookup(file: string, module: string[], raw: string, seen: Set<string>): RustType | undefined {
    const owner = files.get(file);
    if (!owner || owner.localImports) return undefined;
    const text = bareType(raw);
    const wrapper = /^(?:(?:std|core|alloc)::(?:boxed|sync|rc|option|vec)::)?(Box|Arc|Rc|Option|Vec)\s*<(.+)>$/.exec(
      text,
    );
    if (wrapper) {
      const key = [owner.crate, ...module, wrapper[1]].join("::");
      const imported = aliases.filter((alias) => alias.key === key);
      const standard = /^(std|core|alloc)::(boxed|sync|rc|option|vec)::(Box|Arc|Rc|Option|Vec)$/;
      const qualified = standard.test(text.slice(0, text.indexOf("<")).trim());
      const shadowed = types.some((type) => type.key === key);
      if (
        qualified ||
        (!shadowed && (imported.length === 0 || (imported.length === 1 && standard.test(imported[0].target))))
      ) {
        return lookup(file, module, wrapper[2], seen);
      }
    }
    const path = text.replace(/<.*>$/, "").replace(/^::/, "").split("::");
    if (!path.every((part) => /^[A-Za-z_]\w*$/.test(part))) return undefined;
    let parts: string[];
    if (path[0] === "crate") parts = [owner.crate, ...path.slice(1)];
    else if (path[0] === "self") parts = [owner.crate, ...module, ...path.slice(1)];
    else if (path[0] === "super") {
      const parent = [...module];
      while (path[0] === "super") {
        if (!parent.length) return undefined;
        parent.pop();
        path.shift();
      }
      parts = [owner.crate, ...parent, ...path];
    } else if (crates.has(path[0])) parts = path;
    else parts = [owner.crate, ...module, ...path];
    const key = parts.join("::");
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    const matches = types.filter((type) => type.key === key);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    for (let n = parts.length; n >= 2; n--) {
      const candidates = aliases.filter((alias) => alias.key === parts.slice(0, n).join("::"));
      if (!candidates.length) continue;
      if (candidates.length !== 1 || candidates[0].generic) return undefined;
      const alias = candidates[0];
      return lookup(alias.file, alias.module, [alias.target, ...parts.slice(n)].join("::"), next);
    }
    return undefined;
  }
  const resolveType = (file: string, module: string[], text: string) => lookup(file, module, text, new Set());
  for (const [file, data] of files) {
    for (const block of data.impls) {
      const module = [...data.module, ...block.module];
      const type = resolveType(file, module, block.target_type_text);
      if (!type) {
        notes.add(`syntax.unresolved: ${file}:${block.span.start_line} impl ${block.target_type_text}`);
        continue;
      }
      for (const method of block.methods) {
        type.methods.push({
          file,
          module,
          method,
          ...(block.trait_text === undefined ? {} : { trait: block.trait_text }),
        });
      }
    }
  }
  function receiver(file: string, call: CallFact): RustType | undefined {
    const data = files.get(file);
    if (!data) return undefined;
    const scope = [...data.module, ...call.module];
    const parts = (call.receiver_text ?? "").trim().split(".");
    let type: RustType | undefined;
    if (parts[0] === "self") {
      const block = data.impls.find((block) => within(call.span, block.span));
      if (block) type = resolveType(file, scope, block.target_type_text);
    } else if (call.receiver_binding_type) type = resolveType(file, scope, call.receiver_binding_type);
    for (const part of parts.slice(1)) {
      if (!type) return undefined;
      const field = type.fields.find((field) => field.name === part);
      type = field ? resolveType(type.file, type.module, field.type_text) : undefined;
    }
    return type;
  }
  return { files, types, notes, moduleInventories, facts, resolveType, receiver };
}
