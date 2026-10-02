/**
 * The language-neutral layer declaration (`docs/ddd/layer-structure.yaml`):
 * its vocabulary, the normalised shape the loader returns, and the rule ids its findings carry.
 *
 * A context states its dependency regime in business terms — which side of CQRS each package is on,
 * which package depends on which, the ports it talks through, the repositories it restores its
 * aggregates from and the backend behind them. The only thing a language spells is the identity of a
 * package, and a package is the language that spells it together with its name: a name on its own
 * names no package here.
 */

import type { FindingInput } from "../shared/findings.ts";
import { PACKAGE_LANGUAGES, type PackageLanguage } from "../shared/package-name.ts";

/** The Rust-only crate format of an earlier declaration. */

export const LAYER_LANGUAGES = PACKAGE_LANGUAGES;

/** Which side of the context a package stands on; `rmu` is the read-model updater that bridges both. */
export const PACKAGE_ROLES = ["command", "query", "rmu"] as const;
export type PackageRole = (typeof PACKAGE_ROLES)[number];

export const PORT_KINDS = ["repository", "external-client", "es-infrastructure"] as const;
type PortKind = (typeof PORT_KINDS)[number];

export const IO_UNITS = ["single", "collection", "partial"] as const;
type IoUnit = (typeof IO_UNITS)[number];

export const STORE_SEMANTICS = ["upsert", "insert-only", "unknown"] as const;
type StoreSemantics = (typeof STORE_SEMANTICS)[number];

export const RESTORATION_ROUTES = ["full-constructor", "other"] as const;
type RestorationRoute = (typeof RESTORATION_ROUTES)[number];

export const LAYER_RULES = {
  document: "layer-declaration.document",
  version: "layer-declaration.version",
  structure: "layer-declaration.structure",
  unknownKey: "layer-declaration.unknown-key",
  model: "layer-declaration.model",
  reference: "layer-declaration.reference",
  duplicate: "layer-declaration.duplicate",
  coverage: "layer-declaration.coverage",
  requiredItems: "layer-declaration.required-items",
  dependencyRow: "layer-declaration.dependency-row",
  cqrsSides: "layer-declaration.cqrs-sides",
  sideDependency: "layer-declaration.side-dependency",
  queryDomainDependency: "layer-declaration.query-domain-dependency",
  restorationPath: "layer-declaration.restoration-path",
} as const;

type LayerRule = (typeof LAYER_RULES)[keyof typeof LAYER_RULES];

/** A package, in the spelling of the language that names it. */
export interface PackageIdentity {
  readonly language: PackageLanguage;
  readonly package: string;
}

export interface LayerPackage {
  readonly role: PackageRole;
  readonly code: PackageIdentity;
}

export interface PackageDependency {
  readonly code: PackageIdentity;
  /** Only the packages this one depends on directly; a context with none states an empty list. */
  readonly depends_on: readonly PackageIdentity[];
}

export interface PortDeclaration {
  readonly name: string;
  readonly kind: PortKind;
  readonly verbs: readonly string[];
}

export interface RepositoryDeclaration {
  readonly name: string;
  readonly aggregate_ref: string;
  readonly io_unit: IoUnit;
  readonly verbs: readonly string[];
  readonly store_semantics: StoreSemantics;
}

export interface RestorationPath {
  readonly aggregate_ref: string;
  readonly via: RestorationRoute;
  readonly note?: string;
}

export interface LayerStructure {
  readonly context_ref: string;
  readonly cqrs: boolean;
  readonly packages: readonly LayerPackage[];
  readonly dependencies: readonly PackageDependency[];
  readonly ports: readonly PortDeclaration[];
  readonly repositories: readonly RepositoryDeclaration[];
  readonly restoration_paths: readonly RestorationPath[];
  readonly persistence_backend: string;
}

export interface LayerDeclaration {
  readonly model_ref: string;
  readonly layer_structures: readonly LayerStructure[];
}

// ---------------------------------------------------------------------------
// Drafts: what the crate format never stated is absent rather than filled in
// ---------------------------------------------------------------------------

export interface PortDraft {
  readonly name: string;
  readonly kind?: PortKind;
  readonly verbs?: readonly string[];
}

export interface RepositoryDraft {
  readonly name: string;
  readonly aggregate_ref: string;
  readonly io_unit?: IoUnit;
  readonly verbs?: readonly string[];
  readonly store_semantics?: StoreSemantics;
}

export interface RestorationPathDraft {
  readonly aggregate_ref: string;
  readonly via?: RestorationRoute;
  readonly note?: string;
}

export interface LayerStructureDraft
  extends Omit<LayerStructure, "cqrs" | "ports" | "repositories" | "restoration_paths"> {
  readonly cqrs?: boolean;
  readonly ports: readonly PortDraft[];
  readonly repositories: readonly RepositoryDraft[];
  readonly restoration_paths: readonly RestorationPathDraft[];
}

export interface LayerDeclarationDraft extends Omit<LayerDeclaration, "layer_structures"> {
  readonly layer_structures: readonly LayerStructureDraft[];
}

// ---------------------------------------------------------------------------
// Identity and reporting
// ---------------------------------------------------------------------------

/**
 * What makes two package identities one package. Every comparison this module makes goes through
 * here, so a name can never stand for a package on its own.
 */
export function identityKey(identity: PackageIdentity): string {
  return JSON.stringify([identity.language, identity.package]);
}

/** A package as findings name it, e.g. `rust billing-domain`. */
export function describeIdentity(identity: PackageIdentity): string {
  return `${identity.language} ${identity.package}`;
}

/** How a finding names the structure it belongs to, and the positions inside it. */
export function structureWhere(contextRef: string): string {
  return `layer_structures[${contextRef}]`;
}

/** Collects findings against the declaration document. */
export class LayerReport {
  readonly findings: FindingInput[] = [];

  constructor(private readonly file: string) {}

  add(rule: LayerRule, message: string): void {
    this.findings.push({ rule_id: rule, file: this.file, message });
  }

  /** The shape rule of this artifact, which is what the shared value readers report against. */
  structure(message: string): void {
    this.add(LAYER_RULES.structure, message);
  }

  unknownKeys(node: Readonly<Record<string, unknown>>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(node)) {
      if (!allowed.includes(key)) this.add(LAYER_RULES.unknownKey, `${where}: unknown key "${key}"`);
    }
  }
}
