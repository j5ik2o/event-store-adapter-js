/**
 * What the TypeScript rules of one gate are evaluated over: the checked sources of the layers the
 * gate decides, the packages of the project, the facts of every source the rules decide from, the
 * domain types and the declarations those facts declare. Assembled once by `context.ts`; the rules
 * only read it.
 */

import type { MappingViewLoad } from "../../aggregate-mapping/index.ts";
import type { ProjectContext } from "../../project/context.ts";
import type { FindingInput } from "../../shared/findings.ts";
import type {
  DeclarationFact,
  MemberFact,
  ParamFact,
  Span,
  TypeScriptFactSet,
  WriteFact,
} from "../../typescript/domain-facts/index.ts";
import type { Layer } from "../../workspace/resolver.ts";
import type { ModelAvailability } from "../types.ts";
import type { ProjectPackages } from "./edges.ts";
import type { TsPackage } from "./packages.ts";

/**
 * Which checked sources a gate decides and which sources its rules decide from, as the Rust gate of
 * the same layer selects them.
 */
export interface TsGate {
  /** How a message names the gate's rules: `domain`, `use-case` or `interface-adapter`. */
  readonly label: string;
  /** The layers whose checked sources the per-file rules decide. */
  readonly target_layers: readonly Layer[];
  /** Whether a checked source of a query-side package is decided whatever its layer. */
  readonly includes_query_side: boolean;
  /**
   * The layers whose every source is read into the facts besides the checked targets, because a
   * rule resolves a name declared in any of them.
   */
  readonly described_layers: readonly Layer[];
  /** Whether the layer diagnostics of the checked packages are reported, as only the domain gate does. */
  readonly reports_layer_diagnostics: boolean;
}

/** A checked source the per-file rules decide over; `file` is project-root relative. */
export interface TsTarget {
  readonly file: string;
  readonly pkg: TsPackage;
}

/** A method of a domain type that has a body, as the rules judge it. */
export interface TsMethod {
  readonly name: string;
  readonly file: string;
  readonly span: Span;
  readonly params: readonly ParamFact[];
  readonly writes: readonly WriteFact[];
  readonly returns_state_only: boolean;
}

/**
 * A domain type: a class, or a companion — a type literal and a `const` object literal of the same
 * name in one file, whose instances are the literals written inside that object.
 */
export interface TsDomainType {
  /** `<file>#<name>`: the type as a note names it. */
  readonly key: string;
  readonly name: string;
  readonly kind: "class" | "companion";
  /** Whether the type is its module's default export, which an import names `default`. */
  readonly default_export: boolean;
  readonly file: string;
  readonly pkg: TsPackage;
  readonly module: readonly string[];
  /** Where code may construct the type: the class body, or the companion's `const` object. */
  readonly home: Span;
  /** The class members, or the companion's type literal members. */
  readonly members: readonly MemberFact[];
  /** Instance methods with a body: the class's, or those the companion's instances write. */
  readonly methods: readonly TsMethod[];
}

/** A class or a port (an interface, or a type literal alias) a read source declares at its top, with its package. */
export interface TsDeclared {
  readonly file: string;
  readonly pkg: TsPackage;
  readonly declaration: DeclarationFact;
}

export interface TsSymbolTable {
  readonly types: readonly TsDomainType[];
  /** The instance methods of any domain type whose body only returns state. */
  readonly getter_names: ReadonlySet<string>;
}

/**
 * The constructs a rule could not decide, each as `<file>:<line> <what>`. Any of them stops the
 * gate as uninspectable once every rule has run, so no verdict is given over them.
 */
export class Undecided {
  readonly items: string[] = [];

  /** `line` is absent for a construct of a file that has no line of its own, such as a manifest entry. */
  add(file: string, line: number | undefined, what: string): void {
    this.items.push(`${file}${line === undefined ? "" : `:${line}`} ${what}`);
  }
}

export interface TsInspection {
  readonly run: ProjectContext;
  readonly packages: ProjectPackages;
  readonly targets: readonly TsTarget[];
  readonly facts: TypeScriptFactSet;
  readonly symbols: TsSymbolTable;
  /** Every class and port the read sources declare, whatever their layer. */
  readonly declarations: readonly TsDeclared[];
  readonly model: ModelAvailability;
  readonly mapping: MappingViewLoad;
  /** Coverage notes the verdict carries, such as an ambiguous model binding. */
  readonly notes: Set<string>;
  readonly undecided: Undecided;
  readonly layerDiagnostics: readonly FindingInput[];
}
