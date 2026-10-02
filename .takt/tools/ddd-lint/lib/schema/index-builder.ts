/**
 * ElementIndex — the lookup surface `loadDomainModel` returns on success.
 *
 * It exposes only resolved facts: element identity, ownership, and
 * invariant statements. It never hydrates the whole YAML tree for callers.
 */

import { type ElementKind, parseElementId } from "./element-id.ts";
import type { Command, DomainModel, IndexedElement } from "./model.ts";

export type ResolveReason = "undefined" | "deprecated" | "kind-mismatch" | "malformed";

export type ResolveResult = { ok: true; element: IndexedElement } | { ok: false; reason: ResolveReason };

export interface ElementIndex {
  byId(id: string): IndexedElement | undefined;
  resolve(id: string, expectedKind?: ElementKind): ResolveResult;
  commandsOf(aggregateId: string): readonly Command[];
  elements(kind?: ElementKind): readonly IndexedElement[];
  /** IDs retired by the lineage (split / merged / deprecated). */
  retiredIds(): ReadonlySet<string>;
}

export function createElementIndex(
  model: DomainModel,
  registry: Map<string, IndexedElement>,
  commands: Map<string, Command[]>,
): ElementIndex {
  const retired = new Set<string>();
  for (const entry of model.lineage) {
    if (entry.relation === "split" || entry.relation === "merged" || entry.relation === "deprecated") {
      retired.add(entry.element_id);
    }
  }

  return {
    byId(id: string): IndexedElement | undefined {
      return registry.get(id);
    },
    resolve(id: string, expectedKind?: ElementKind): ResolveResult {
      if (!parseElementId(id).ok) return { ok: false, reason: "malformed" };
      const element = registry.get(id);
      if (!element) {
        return retired.has(id) ? { ok: false, reason: "deprecated" } : { ok: false, reason: "undefined" };
      }
      if (expectedKind && element.kind !== expectedKind) {
        return { ok: false, reason: "kind-mismatch" };
      }
      return { ok: true, element };
    },
    commandsOf(aggregateId: string): readonly Command[] {
      return commands.get(aggregateId) ?? [];
    },
    elements(kind?: ElementKind): readonly IndexedElement[] {
      const all = [...registry.values()];
      return kind ? all.filter((element) => element.kind === kind) : all;
    },
    retiredIds(): ReadonlySet<string> {
      return retired;
    },
  };
}
