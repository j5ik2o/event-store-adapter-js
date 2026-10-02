/**
 * One language's view of the implementation mapping: what the source gates of that language receive.
 *
 * The mapping is language-neutral and may place some aggregates and packages in one language and
 * the rest in another. A source gate binds the types and modules of its own language only, so the
 * view keeps the entries placed in that language and leaves every other language out. Nothing here
 * re-decides whether the mapping is sound: a mapping the reader refuses has no view at all, and the
 * reader's findings say why.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAPPING_FILE } from "../schema/artifacts.ts";
import type { FindingInput } from "../shared/findings.ts";
import type { MappingLanguage } from "./contract.ts";
import { loadAggregateMapping } from "./loader.ts";

/** One mapped operation: the method, and the types its `Result` states. */
export interface OperationView {
  readonly operation_ref: string;
  readonly method: string;
  readonly error_type: string;
  readonly success_type?: string;
}

/** One aggregate placed in the view's language: its type, operations, replay methods, package and module path. */
export interface AggregateMappingView {
  readonly aggregate_ref: string;
  readonly type: string;
  readonly operations: readonly OperationView[];
  readonly persistence_method: string;
  readonly package: string;
  /** The module path below the package root, one segment per entry, spelled as the mapping wrote it. */
  readonly module: readonly string[];
  readonly replay_methods: readonly { readonly method: string; readonly event_ref: string }[];
}

interface PackageMappingView {
  readonly package: string;
  readonly module: readonly string[];
}

interface MappingView {
  readonly aggregates: readonly AggregateMappingView[];
  readonly packages: readonly PackageMappingView[];
}

export type MappingViewLoad =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly findings: readonly FindingInput[] }
  | { readonly kind: "loaded"; readonly view: MappingView };

/** Where the implementation mapping of a project whose model files live in `modelDir` is. */
export function mappingPathOf(modelDir: string): string {
  return join(modelDir, MAPPING_FILE);
}

/**
 * The `language` view of the mapping in `modelDir`. A project without a mapping has none, which is
 * a different fact from a mapping that cannot be read.
 */
export function loadMappingView(modelDir: string, language: MappingLanguage): MappingViewLoad {
  const path = mappingPathOf(modelDir);
  if (!existsSync(path)) return { kind: "absent" };
  const loaded = loadAggregateMapping(path);
  if (!loaded.ok) return { kind: "invalid", findings: loaded.findings };
  return {
    kind: "loaded",
    view: {
      aggregates: loaded.mapping.aggregate_mappings
        .filter((entry) => entry.code.language === language)
        .map((entry) => ({
          aggregate_ref: entry.aggregate_ref,
          type: entry.code.type,
          operations: entry.operations.map((operation) => ({
            operation_ref: operation.operation_ref,
            method: operation.code.method,
            error_type: operation.code.error_type,
            ...(operation.code.success_type === undefined ? {} : { success_type: operation.code.success_type }),
          })),
          persistence_method: entry.persistence_method,
          package: entry.code.package,
          module: entry.code.module,
          replay_methods: entry.replay_methods.map((replay) => ({
            method: replay.code.method,
            event_ref: replay.event_ref,
          })),
        })),
      packages: loaded.mapping.domain_packages
        .filter((entry) => entry.code.language === language)
        .map((entry) => ({ package: entry.code.package, module: entry.code.module })),
    },
  };
}
