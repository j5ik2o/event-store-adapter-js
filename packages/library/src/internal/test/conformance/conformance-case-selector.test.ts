import * as backendModule from "./conformance-backend";
import { CONFORMANCE_BACKENDS } from "./conformance-backend";
import type { ConformanceCase } from "./conformance-case";
import { selectConformanceCases } from "./conformance-case-selector";

const scenario = (backends: readonly string[]): ConformanceCase => ({
  id: "s",
  rules: ["BT-7"],
  source: "bigtable/journal-write.json",
  format: "scenarios",
  body: { id: "s", backends: [...backends] },
});

test("bigtable is one of the conformance backends", () => {
  expect(CONFORMANCE_BACKENDS).toContain("bigtable");
});

test("the unprovided-backend helper no longer exists", () => {
  expect("targetsOnlyUnprovidedBackends" in backendModule).toBe(false);
});

test("a bigtable-only scenario is selected for bigtable only", () => {
  const cases = [scenario(["bigtable"])];
  expect(selectConformanceCases(cases, "bigtable")).toHaveLength(1);
  for (const backend of ["memory", "dynamodb", "sqlite", "spanner"] as const) {
    expect(selectConformanceCases(cases, backend)).toHaveLength(0);
  }
});

test("a scenario that targets bigtable and sqlite is selected for both", () => {
  const cases = [scenario(["bigtable", "sqlite"])];
  expect(selectConformanceCases(cases, "bigtable")).toHaveLength(1);
  expect(selectConformanceCases(cases, "sqlite")).toHaveLength(1);
  expect(selectConformanceCases(cases, "spanner")).toHaveLength(0);
});
