/**
 * The type a mapped operation is a method of: the aggregate type, except for a factory rule that
 * builds another element of the aggregate (a Domain Primitive, a value object), whose factory is a
 * method of that element's type.
 */

import type { ModelAvailability } from "./types.ts";

export function operationOwner(model: ModelAvailability, operationRef: string, aggregateType: string): string {
  if (!operationRef.startsWith("factory.") || !model.index) return aggregateType;
  const target = (model.index.byId(operationRef)?.node as { target_element?: unknown } | undefined)?.target_element;
  if (typeof target !== "string") return aggregateType;
  return model.index.byId(target)?.name ?? aggregateType;
}
