/**
 * The Rust view of the implementation mapping: what the Rust code checks receive.
 *
 * Which entries are placed in Rust is the language-neutral view's decision; this only spells their
 * location the way the Rust code checks compare it — a crate name and the module path below its
 * root.
 */

import { loadMappingView } from "../../aggregate-mapping/index.ts";
import type { OperationView } from "../../aggregate-mapping/view.ts";
import type { FindingInput } from "../../shared/findings.ts";

/** One aggregate as the Rust rules compare it: replay methods, its crate and its module path. */
export interface RustAggregateMapping {
  readonly aggregate_ref: string;
  readonly type: string;
  readonly operations: readonly OperationView[];
  readonly persistence_method: string;
  readonly crate: string;
  /** The module path below the crate root, one segment per entry, spelled as the mapping wrote it. */
  readonly module: readonly string[];
  readonly replay_methods: readonly { readonly method: string; readonly event_ref: string }[];
}

export interface RustPackageMapping {
  readonly crate: string;
  readonly module: readonly string[];
}

export interface RustMappingView {
  readonly aggregates: readonly RustAggregateMapping[];
  readonly packages: readonly RustPackageMapping[];
}

export type RustMappingLoad =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly findings: readonly FindingInput[] }
  | { readonly kind: "loaded"; readonly view: RustMappingView };

/**
 * The Rust view of the mapping in `modelDir`. A project without a mapping has none, which is a
 * different fact from a mapping that cannot be read in the current format.
 */
export function loadRustMapping(modelDir: string): RustMappingLoad {
  const loaded = loadMappingView(modelDir, "rust");
  if (loaded.kind !== "loaded") return loaded;
  return {
    kind: "loaded",
    view: {
      aggregates: loaded.view.aggregates.map(({ package: crate, ...entry }) => ({ ...entry, crate })),
      packages: loaded.view.packages.map(({ package: crate, module }) => ({ crate, module })),
    },
  };
}
