/**
 * How a TypeScript domain type is bound to a model aggregate, for the rules of every gate that ask
 * whether a type is an aggregate root: the aggregate mappings the run loaded, and the mapping that
 * locates a type.
 */

import type { AggregateMappingView } from "../../aggregate-mapping/index.ts";
import { bindAggregate } from "../mutations.ts";
import type { TsDomainType, TsInspection } from "./types.ts";

export function aggregateMappings(inspection: TsInspection): readonly AggregateMappingView[] {
  return inspection.mapping.kind === "loaded" ? inspection.mapping.view.aggregates : [];
}

export function locatedAt(type: TsDomainType) {
  return (mapping: AggregateMappingView) =>
    mapping.package === type.pkg.name && mapping.module.join("/") === type.module.join("/");
}

/**
 * The model aggregate a domain type is the root of, as the mutation rules bind it, and whether that
 * binding is ambiguous.
 */
export function aggregateBinding(inspection: TsInspection, type: TsDomainType) {
  const sameNames = inspection.symbols.types.filter((entry) => entry.name === type.name).length;
  return bindAggregate(
    type,
    sameNames,
    inspection.model,
    aggregateMappings(inspection),
    locatedAt(type),
    inspection.notes,
  );
}
