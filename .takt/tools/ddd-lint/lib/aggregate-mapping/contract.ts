/**
 * The language-neutral implementation mapping (`docs/ddd/aggregate-mapping.yaml`): its
 * vocabulary, the normalised shape the loader returns, and the rule ids its findings carry.
 *
 * Business identity — model ids, business vocabulary, execution model and persistence — sits at the
 * top of every entry. Everything a language spells — package, module path, type, method, error
 * case — sits under `code`. Compiler symbol ids, source files and lines have no place in the shape,
 * and neither does a table of every export: the mapping names what the model needs, nothing more.
 */

import type { FindingInput } from "../shared/findings.ts";

/** The Rust-only crate/module format of an earlier mapping. */

export const MAPPING_LANGUAGES = ["rust", "typescript"] as const;
export type MappingLanguage = (typeof MAPPING_LANGUAGES)[number];

export const PROGRAMMING_MODELS = ["actor", "class"] as const;
type ProgrammingModel = (typeof PROGRAMMING_MODELS)[number];

export const PERSISTENCE_METHODS = ["state-sourcing", "event-sourcing"] as const;
type PersistenceMethod = (typeof PERSISTENCE_METHODS)[number];

export const MAPPING_RULES = {
  document: "aggregate-mapping.document",
  version: "aggregate-mapping.version",
  structure: "aggregate-mapping.structure",
  unknownKey: "aggregate-mapping.unknown-key",
  model: "aggregate-mapping.model",
  reference: "aggregate-mapping.reference",
  ownerMismatch: "aggregate-mapping.owner-mismatch",
  duplicate: "aggregate-mapping.duplicate",
  coverage: "aggregate-mapping.coverage",
  technicalName: "aggregate-mapping.technical-name",
} as const;

type MappingRule = (typeof MAPPING_RULES)[keyof typeof MAPPING_RULES];

/** Where code lives, in the spelling of its language. */
export interface CodeLocation {
  readonly language: MappingLanguage;
  readonly package: string;
  /** The module path below the package root, one segment per entry; the root itself is `[]`. */
  readonly module: readonly string[];
}

export interface AggregateCode extends CodeLocation {
  readonly type: string;
  readonly ports: readonly string[];
  readonly repository?: string;
}

export interface ReplayMethodMapping {
  readonly event_ref: string;
  readonly code: { readonly method: string };
}

export interface ErrorCaseMapping {
  readonly error_ref: string;
  readonly code: { readonly case: string };
}

/**
 * A command or factory rule of the model, with the method that performs it, its success type and
 * its error type. A command names its success type; a factory rule's success is the aggregate type.
 */
export interface OperationMapping {
  readonly operation_ref: string;
  readonly code: { readonly method: string; readonly error_type: string; readonly success_type?: string };
  readonly errors: readonly ErrorCaseMapping[];
}

export interface AggregateMapping {
  readonly aggregate_ref: string;
  readonly programming_model: ProgrammingModel;
  readonly persistence_method: PersistenceMethod;
  readonly reference_ids: readonly string[];
  /** Only the methods the team declared; an aggregate that declares none has an empty list. */
  readonly replay_methods: readonly ReplayMethodMapping[];
  readonly code: AggregateCode;
  readonly operations: readonly OperationMapping[];
}

export interface DomainPackageMapping {
  readonly term: string;
  readonly model_refs: readonly string[];
  readonly rationale: string;
  readonly code: CodeLocation;
}

export interface ImplementationMapping {
  readonly model_ref: string;
  readonly aggregate_mappings: readonly AggregateMapping[];
  readonly domain_packages: readonly DomainPackageMapping[];
}

/**
 * An aggregate as read, before completeness is known: its type name may still be missing, which
 * validation reports rather than fills in.
 */
export interface AggregateMappingDraft extends Omit<AggregateMapping, "code"> {
  readonly code: Omit<AggregateCode, "type"> & { readonly type?: string };
}

export interface MappingDraft extends Omit<ImplementationMapping, "aggregate_mappings"> {
  readonly aggregate_mappings: readonly AggregateMappingDraft[];
}

/** Collects findings against the mapping document. */
export class MappingReport {
  readonly findings: FindingInput[] = [];

  constructor(private readonly file: string) {}

  add(rule: MappingRule, message: string): void {
    this.findings.push({ rule_id: rule, file: this.file, message });
  }

  /** The shape rule of this artifact, which is what the shared value readers report against. */
  structure(message: string): void {
    this.add(MAPPING_RULES.structure, message);
  }

  unknownKeys(node: Readonly<Record<string, unknown>>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(node)) {
      if (!allowed.includes(key)) this.add(MAPPING_RULES.unknownKey, `${where}: unknown key "${key}"`);
    }
  }
}
