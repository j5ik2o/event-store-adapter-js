/**
 * Protocol version 7 of the native extractor: the facts every Rust rule decides on.
 *
 * The launch classification is the shared one in `native/launch.ts`; this module owns the protocol
 * identity, the one batch this inspection sends, and the strict conversion of native spellings into
 * the records the rule layer reads. Native spellings never leave it.
 *
 * Every condition that would leave a requested file without facts — a file too large to send, a
 * run that did not finish, an answer that is not this protocol — is reported as one unavailable
 * result. An empty fact set is never produced as a stand-in, because "this file declares nothing"
 * is exactly the answer an uninspected file must not give.
 */

import { ToolUnavailableError } from "../../project/context.ts";
import { classifyNativeExtractor, type NativeOutcome, nativeIssue } from "../native/launch.ts";
import { NATIVE_BIN_DIR, PLATFORM_KEY } from "../native/manifest.ts";

const PROTOCOL = { flag: "--domain-facts-version", version: 7 };
/** The unresolved reason the extractor gives an attribute that may replace the item it annotates. */
const ATTRIBUTE_MACRO_REASON = "attribute-macro";
/** The extractor refuses a larger request, so an oversized batch is refused before it is sent. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Lines and columns are 1-based, as a reader counts them. */
export interface Span {
  readonly start_line: number;
  readonly start_col: number;
  readonly end_line: number;
  readonly end_col: number;
}

/** How a method takes the value it is declared on, as the source writes it. */
export type Receiver = "none" | "self" | "ref-self" | "mut-self" | "other";
export type Visibility = "private" | "pub" | "pub-crate" | "pub-super" | "pub-in";

/** A non-private member of a struct declaration, spelled as the source spells it. */
export interface PublicMember {
  readonly typeName: string;
  /** A field identifier, raw prefix included, or the ordinal of a tuple member. */
  readonly name: string;
  readonly line: number;
}

export interface FieldFact {
  readonly name: string;
  readonly visibility: Visibility;
  readonly type_text: string;
  readonly line: number;
}

export interface TypeFact {
  readonly name: string;
  readonly kind: "struct" | "enum";
  readonly module: readonly string[];
  /** Named fields only: a tuple element is reached by position and declares no name to resolve. */
  readonly fields: readonly FieldFact[];
  readonly derives: readonly string[];
  /** Where the declaration opens, which is where a finding against it sends a reader. */
  readonly line: number;
}

export interface TraitFact {
  readonly name: string;
  readonly module: readonly string[];
  readonly methods: readonly string[];
  /** Where the declaration opens, which is where a finding against it sends a reader. */
  readonly line: number;
}

export interface ParamFact {
  readonly name: string;
  readonly type_text: string;
}

export interface MethodFact {
  readonly name: string;
  readonly receiver: Receiver;
  readonly params: readonly ParamFact[];
  readonly return_type_text?: string;
  /** Whether the body only hands back a member of `self`. */
  readonly returns_field_only: boolean;
  readonly line: number;
}

export interface ImplFact {
  readonly module: readonly string[];
  readonly target_type_text: string;
  readonly trait_text?: string;
  readonly methods: readonly MethodFact[];
  readonly span: Span;
}

/**
 * A function declared outside an impl block. The walk reaches a function through the item that holds
 * it, so one written in the default value of a trait associated constant is not recorded here. A
 * method of an impl block is carried by that block's own methods instead.
 */
export interface FunctionFact {
  readonly module: readonly string[];
  readonly name: string;
  readonly params: readonly ParamFact[];
  readonly line: number;
}

export interface UseFact {
  readonly module: readonly string[];
  readonly path_text: string;
  /** Declared inside a function body, where it binds no name the module scope can resolve. */
  readonly local: boolean;
  readonly line: number;
}

export interface AliasFact {
  readonly module: readonly string[];
  readonly name: string;
  readonly type_text: string;
  readonly generic: boolean;
  readonly local: boolean;
}

export interface ConstructionFact {
  readonly kind: "struct-literal" | "update-syntax" | "associated-call" | "default-call";
  readonly type_text: string;
  readonly callee_text?: string;
  readonly span: Span;
}

export interface CallFact {
  readonly module: readonly string[];
  readonly kind: "method-call" | "path-call";
  readonly callee_text: string;
  readonly receiver_text?: string;
  /** Explicit parameter/let type only; never inferred from an expression. */
  readonly receiver_binding_type?: string;
  /** Every use of this call's result reaches these calls unchanged; empty if unproven. */
  readonly forwarded_argument_calls: readonly Span[];
  readonly span: Span;
}

export interface ModuleFact {
  readonly name: string;
  readonly module: readonly string[];
  readonly inline: boolean;
  /** The decoded `#[path]` target, absent when the declaration carries none. */
  readonly path?: string;
  readonly unresolved_path: boolean;
  readonly auxiliary: boolean;
  readonly local: boolean;
  readonly line: number;
}

/** An item-position macro call, which may declare items this protocol cannot see. */
export interface ItemMacroFact {
  readonly line: number;
  readonly auxiliary: boolean;
}

/** What one file of the inspected program declares. A file without a record was not read. */
export interface RustFileFacts {
  /** The file is `#![cfg(test)]`, so nothing it declares belongs to the inspected program. */
  readonly auxiliary: boolean;
  readonly publicMembers: readonly PublicMember[];
  readonly types: readonly TypeFact[];
  readonly traits: readonly TraitFact[];
  readonly impls: readonly ImplFact[];
  readonly functions: readonly FunctionFact[];
  readonly uses: readonly UseFact[];
  readonly aliases: readonly AliasFact[];
  readonly constructions: readonly ConstructionFact[];
  readonly calls: readonly CallFact[];
  readonly modules: readonly ModuleFact[];
  readonly itemMacros: readonly ItemMacroFact[];
  /**
   * The line of every attribute that may be an attribute macro. Such a macro replaces the item it
   * annotates, so what this file declares cannot be decided from its syntax alone.
   */
  readonly attributeMacros: readonly number[];
}

export interface DomainFactSet {
  /** Workspace-relative file -> what it declares. A file the extractor could not read has none. */
  readonly files: ReadonlyMap<string, RustFileFacts>;
  /** One line per construct that could hide a declaration from this answer. */
  readonly notes: readonly string[];
}

/** One source of the inspected program, as the extractor is asked about it. */
export interface RustSourceFile {
  /** Workspace-relative path; the answer is keyed by it. */
  readonly file: string;
  readonly source: string;
}

export type DomainFactResult =
  | { readonly kind: "facts"; readonly facts: DomainFactSet }
  | { readonly kind: "unavailable"; readonly detail: string };

export function classifyDomainFactExtractor(): Promise<NativeOutcome> {
  return classifyNativeExtractor(NATIVE_BIN_DIR, PLATFORM_KEY, PROTOCOL);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected native object");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected native array");
  return value;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.length) throw new Error("expected native text");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected native text");
  return value;
}

/** Text the answer may leave unset, which is not the same as text it left empty. */
function optional(value: unknown): string | undefined {
  if (value === null) return undefined;
  return nonempty(value);
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("expected a native verdict");
  return value;
}

function line(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("invalid native line");
  return value;
}

function words(value: unknown): string[] {
  return array(value).map(nonempty);
}

function span(value: unknown): Span {
  const raw = object(value);
  return {
    start_line: line(raw.start_line),
    start_col: line(raw.start_col),
    end_line: line(raw.end_line),
    end_col: line(raw.end_col),
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  const name = nonempty(value);
  if (!(allowed as readonly string[]).includes(name)) throw new Error(`unknown native value ${name}`);
  return name as T;
}

function member(value: unknown): PublicMember {
  const raw = object(value);
  return { typeName: nonempty(raw.type), name: nonempty(raw.member), line: line(raw.line) };
}

function field(value: unknown): FieldFact {
  const raw = object(value);
  return {
    name: nonempty(raw.name),
    visibility: oneOf(raw.visibility, ["private", "pub", "pub-crate", "pub-super", "pub-in"] as const),
    type_text: nonempty(raw.type_text),
    line: line(raw.line),
  };
}

/** One declared parameter. A method and a function outside an impl block declare them alike. */
function parameter(value: unknown): ParamFact {
  const raw = object(value);
  return { name: text(raw.name), type_text: text(raw.type_text) };
}

function declaredType(value: unknown): TypeFact {
  const raw = object(value);
  return {
    name: nonempty(raw.name),
    kind: oneOf(raw.kind, ["struct", "enum"] as const),
    module: words(raw.module),
    fields: array(raw.fields).map(field),
    derives: words(raw.derives),
    line: line(raw.line),
  };
}

function declaredTrait(value: unknown): TraitFact {
  const raw = object(value);
  return {
    name: nonempty(raw.name),
    module: words(raw.module),
    methods: words(raw.methods),
    line: line(raw.line),
  };
}

function declaredFunction(value: unknown): FunctionFact {
  const raw = object(value);
  return {
    module: words(raw.module),
    name: nonempty(raw.name),
    params: array(raw.params).map(parameter),
    line: line(raw.line),
  };
}

function method(value: unknown): MethodFact {
  const raw = object(value);
  const returnType = optional(raw.return_type_text);
  return {
    name: nonempty(raw.name),
    receiver: oneOf(raw.receiver, ["none", "self", "ref-self", "mut-self", "other"] as const),
    params: array(raw.params).map(parameter),
    ...(returnType === undefined ? {} : { return_type_text: returnType }),
    returns_field_only: flag(raw.returns_field_only),
    line: line(raw.line),
  };
}

function implBlock(value: unknown): ImplFact {
  const raw = object(value);
  const trait = optional(raw.trait_text);
  return {
    module: words(raw.module),
    target_type_text: nonempty(raw.target_type_text),
    ...(trait === undefined ? {} : { trait_text: trait }),
    methods: array(raw.methods).map(method),
    span: span(raw.span),
  };
}

function importPath(value: unknown): UseFact {
  const raw = object(value);
  return {
    module: words(raw.module),
    path_text: nonempty(raw.path_text),
    local: flag(raw.local),
    line: line(raw.line),
  };
}

function alias(value: unknown): AliasFact {
  const raw = object(value);
  return {
    module: words(raw.module),
    name: nonempty(raw.name),
    type_text: nonempty(raw.type_text),
    generic: flag(raw.generic),
    local: flag(raw.local),
  };
}

function construction(value: unknown): ConstructionFact {
  const raw = object(value);
  const callee = optional(raw.callee_text);
  return {
    kind: oneOf(raw.kind, ["struct-literal", "update-syntax", "associated-call", "default-call"] as const),
    type_text: text(raw.type_text),
    ...(callee === undefined ? {} : { callee_text: callee }),
    span: span(raw.span),
  };
}

function call(value: unknown): CallFact {
  const raw = object(value);
  const receiver = optional(raw.receiver_text);
  const binding = optional(raw.receiver_binding_type);
  return {
    module: words(raw.module),
    kind: oneOf(raw.kind, ["method-call", "path-call"] as const),
    callee_text: nonempty(raw.callee_text),
    ...(receiver === undefined ? {} : { receiver_text: receiver }),
    ...(binding === undefined ? {} : { receiver_binding_type: binding }),
    forwarded_argument_calls: array(raw.forwarded_argument_calls).map(span),
    span: span(raw.span),
  };
}

function moduleDeclaration(value: unknown): ModuleFact {
  const raw = object(value);
  const path = optional(raw.path);
  return {
    name: nonempty(raw.name),
    module: words(raw.module),
    inline: flag(raw.inline),
    ...(path === undefined ? {} : { path }),
    unresolved_path: flag(raw.unresolved_path),
    auxiliary: flag(raw.auxiliary),
    local: flag(raw.local),
    line: line(raw.line),
  };
}

function itemMacro(value: unknown): ItemMacroFact {
  const raw = object(value);
  return { line: line(raw.line), auxiliary: flag(raw.auxiliary) };
}

function fileFacts(record: Record<string, unknown>): RustFileFacts {
  return {
    auxiliary: flag(record.auxiliary),
    publicMembers: array(record.members).map(member),
    types: array(record.types).map(declaredType),
    traits: array(record.traits).map(declaredTrait),
    impls: array(record.impls).map(implBlock),
    functions: array(record.functions).map(declaredFunction),
    uses: array(record.uses).map(importPath),
    aliases: array(record.aliases).map(alias),
    constructions: array(record.constructions).map(construction),
    calls: array(record.calls).map(call),
    modules: array(record.modules).map(moduleDeclaration),
    itemMacros: array(record.item_macros).map(itemMacro),
    attributeMacros: array(record.unresolved)
      .map(object)
      .filter((reason) => nonempty(reason.reason) === ATTRIBUTE_MACRO_REASON)
      .map((reason) => line(reason.line)),
  };
}

function convert(response: unknown, requested: readonly RustSourceFile[]): DomainFactSet {
  const raw = object(response);
  if (raw.protocol_version !== PROTOCOL.version) throw new Error("native protocol mismatch");
  const entries = array(raw.files);
  if (entries.length !== requested.length) throw new Error("native answer does not cover the request");
  const files = new Map<string, RustFileFacts>();
  const notes = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const record = object(entry);
    const file = requested[index].file;
    if (record.path !== file) throw new Error("native answer is not in the order it was requested");
    for (const item of array(record.unresolved)) {
      const reason = object(item);
      notes.add(`domain-facts.unresolved: ${file}:${line(reason.line)} ${nonempty(reason.reason)}`);
    }
    if (record.parsed !== true) {
      if (record.parsed !== false) throw new Error("invalid native parse state");
      continue;
    }
    if (files.has(file)) throw new Error(`the answer covers ${file} twice`);
    files.set(file, fileFacts(record));
  }
  return { files, notes: [...notes].sort() };
}

/** One request as the extractor reads it. */
function requestOf(sources: readonly RustSourceFile[]): string {
  return JSON.stringify({
    protocol_version: PROTOCOL.version,
    files: sources.map((entry) => ({ path: entry.file, source: entry.source })),
  });
}

/**
 * The sources split into requests the extractor accepts, in the order they were given. Facts are
 * per file, so where one request ends changes no answer. A file that does not fit even alone cannot
 * be split, so it is named instead.
 */
function requestsOf(sources: readonly RustSourceFile[]): RustSourceFile[][] | { readonly oversized: string } {
  const envelope = Buffer.byteLength(requestOf([]));
  const requests: RustSourceFile[][] = [];
  let current: RustSourceFile[] = [];
  let size = envelope;
  for (const entry of sources) {
    // The separating comma is counted with every file, which can only overstate the size.
    const own = Buffer.byteLength(JSON.stringify({ path: entry.file, source: entry.source })) + 1;
    if (envelope + own > MAX_REQUEST_BYTES) return { oversized: entry.file };
    if (current.length > 0 && size + own > MAX_REQUEST_BYTES) {
      requests.push(current);
      current = [];
      size = envelope;
    }
    current.push(entry);
    size += own;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

/** One run of the extractor over one request. */
function readRequest(binaryPath: string, sources: readonly RustSourceFile[]): DomainFactResult {
  const run = Bun.spawnSync([binaryPath], {
    stdin: Buffer.from(requestOf(sources)),
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
  });
  // A run stopped by the timeout reports a signal rather than a status, so both are named: an
  // unfinished run is reported as itself, not as an answer that happened to be empty.
  if (run.exitCode !== 0)
    return {
      kind: "unavailable",
      detail: `the native extractor did not complete its ${PROTOCOL.flag} batch (exit ${run.exitCode}, signal ${run.signalCode}): ${run.stderr.toString().trim()}`,
    };
  let response: unknown;
  try {
    response = JSON.parse(run.stdout.toString());
  } catch {
    return { kind: "unavailable", detail: "the native extractor answered with text that is not JSON" };
  }
  try {
    return { kind: "facts", facts: convert(response, sources) };
  } catch (error) {
    return {
      kind: "unavailable",
      detail: `the ${PROTOCOL.flag} answer cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Runs the classified extractor over every source of the inspected program. `binaryPath` is the one
 * the launch classification resolved and verified, so this call is the run alone.
 *
 * The sources go out in as many requests as the extractor's request limit needs and the answers
 * are joined, so the size of a project never stops an inspection by itself. `between` runs before
 * every request after the first: a caller with a time budget checks it there, since one request is
 * the smallest unit a run can be stopped at. Any request that is not answered leaves the whole
 * result unavailable, as one oversized request did.
 */
export function readDomainFacts(
  binaryPath: string,
  sources: readonly RustSourceFile[],
  between: () => void = () => {},
): DomainFactResult {
  // The request contract needs at least one file, and a batch with none has nothing to answer for.
  if (sources.length === 0) return { kind: "facts", facts: { files: new Map(), notes: [] } };
  const requests = requestsOf(sources);
  if (!Array.isArray(requests))
    return {
      kind: "unavailable",
      detail: `${requests.oversized} alone exceeds the native extractor's ${MAX_REQUEST_BYTES}-byte request limit`,
    };
  const files = new Map<string, RustFileFacts>();
  const notes = new Set<string>();
  for (const [index, request] of requests.entries()) {
    if (index > 0) between();
    const result = readRequest(binaryPath, request);
    if (result.kind === "unavailable") return result;
    for (const [file, facts] of result.facts.files) {
      if (files.has(file)) return { kind: "unavailable", detail: `the answer covers ${file} twice` };
      files.set(file, facts);
    }
    for (const note of result.facts.notes) notes.add(note);
  }
  return { kind: "facts", facts: { files, notes: [...notes].sort() } };
}

/**
 * The one place an extractor these facts cannot be decided from becomes a stopped inspection.
 *
 * A launch an entry classified as unusable and a run that did not answer both reach the same
 * terminal, so an extractor that cannot be read from never turns into a verdict. Every entry that
 * decides on these facts converts through here, which is what keeps the two conditions and the
 * reason each carries from drifting apart between entries. Callers decide when they have something
 * to decide on; a run with nothing to ask about never reaches this.
 */
export function requireDomainFacts(
  extractor: NativeOutcome,
  sources: readonly RustSourceFile[],
  between: () => void = () => {},
): DomainFactSet {
  if (extractor.kind !== "ready") throw new ToolUnavailableError(nativeIssue(extractor).message);
  const result = readDomainFacts(extractor.binaryPath, sources, between);
  if (result.kind === "unavailable") throw new ToolUnavailableError(result.detail);
  return result.facts;
}
