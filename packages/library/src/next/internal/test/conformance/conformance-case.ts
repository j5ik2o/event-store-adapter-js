import type { ConformanceJsonValue } from "./conformance-json-value";

export type ConformanceCase = {
  id: string;
  rules: readonly string[];
  source: string;
  format: "values" | "scenarios" | "layout";
  body: ConformanceJsonValue;
};
