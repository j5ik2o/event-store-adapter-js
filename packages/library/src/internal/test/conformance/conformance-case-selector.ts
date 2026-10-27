import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCase } from "./conformance-case";

const targetsBackend = (
  c: ConformanceCase,
  backend: ConformanceBackend,
): boolean => {
  if (c.format === "values") {
    return true;
  }
  if (c.format === "layout") {
    return backend === "dynamodb";
  }
  const backends = (c.body as { readonly backends?: unknown }).backends;
  return Array.isArray(backends) && backends.includes(backend);
};

export function selectConformanceCases(
  cases: readonly ConformanceCase[],
  backend: ConformanceBackend,
): readonly ConformanceCase[] {
  return cases.filter((c) => targetsBackend(c, backend));
}
