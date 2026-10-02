/**
 * Inspection context types. They do not redefine the workspace and schema types;
 * it composes them here for the rule evaluators.
 */

import type { ProjectContext, SourceFile } from "../project/context.ts";
import type { ElementIndex } from "../schema/index-builder.ts";
import type { CargoWorkspace, CrateLayerAssignment, FileClassification, Layer } from "../workspace/resolver.ts";
import type { ExternalCrateRule } from "./lists.ts";
import type { RustMappingLoad } from "./rust/mapping.ts";
import type { RustProgram } from "./rust/program.ts";

export interface InspectionTarget {
  sourceFile: SourceFile;
  classification: FileClassification;
  /**
   * The checked file the per-file rules decide over, present only when the inspection could read it.
   * Absent means the file stays a target the rules have to decide — it carries no declarations of its
   * own, so no per-file rule evaluates it — rather than a file dropped from the inspection.
   */
  file?: string;
  crate_name?: string;
}

export interface ModelAvailability {
  status: "available" | "skipped" | "absent" | "invalid";
  index?: ElementIndex;
  note?: string;
}

export interface MutatorSymbol {
  file: string;
  method_name: string;
  command_slug: string;
  classification: "declared-command" | "replay-exempt" | "post-init" | "undeclared" | "unknown";
  line: number;
}

export interface DomainTypeSymbol {
  key: string;
  type_name: string;
  crate_name: string;
  file: string;
  kind: "struct" | "enum";
  aggregate_slug: string;
  aggregate_ref?: string;
  constructors: string[];
  mutators: MutatorSymbol[];
  has_default: boolean;
  defaults: { file: string; line: number }[];
  non_private_field_lines: number[];
  field_type_texts: string[];
}

export interface DomainSymbolTable {
  crates: string[];
  types: DomainTypeSymbol[];
  /**
   * The inherent methods of domain types whose body only hands back a member of `self`, as the
   * native extractor reported them.
   */
  getter_names: ReadonlySet<string>;
  type_names: Set<string>;
  /** method name -> owning type names, for the constructor lookup in (n). */
  constructors_by_type: Map<string, Set<string>>;
  file_count: number;
}

export interface DependencyEdge {
  from_crate: string;
  to_crate: string;
  evidence: "use-path" | "cargo-dependency";
  file: string;
  line?: number;
  verdict: "ok" | "layer-forbidden" | "cross-side" | "external-io";
}

export interface InspectionContext {
  /** The implementation mapping of the project, projected onto what the Rust rules compare. */
  rustMapping: RustMappingLoad;
  run: ProjectContext;
  workspace: CargoWorkspace;
  assignments: CrateLayerAssignment[];
  targets: InspectionTarget[];
  skipped: InspectionTarget[];
  symbols: DomainSymbolTable;
  program: RustProgram;
  model: ModelAvailability;
  denylist: readonly ExternalCrateRule[];
  edges: DependencyEdge[];
  layerDiagnostics: { code: string; file: string; message: string }[];
  targetLayers: readonly Layer[];
  includesQuerySide: boolean;
}
