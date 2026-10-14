import * as fs from "node:fs";
import * as path from "node:path";

export type ApiSurfaceMapping = Readonly<{
  module: string;
  value_types: Readonly<Record<string, string>>;
  containers: Readonly<{
    none: string;
    optional: string;
    list: readonly string[];
  }>;
  types: Readonly<
    Record<
      string,
      Readonly<{
        name: string;
        type_parameters: Readonly<Record<string, string>>;
        elements: Readonly<Record<string, string>>;
        construction?: Readonly<{ function: string; input: string }>;
      }>
    >
  >;
  store: Readonly<{
    name: string;
    type_parameters: Readonly<Record<string, string>>;
    result: string;
    operations: Readonly<Record<string, string>>;
  }>;
  error_categories: Readonly<{
    type: string;
    discriminant: string;
    names: Readonly<Record<string, string>>;
  }>;
}>;

export function loadApiSurfaceMapping(root: string): ApiSurfaceMapping {
  return JSON.parse(
    fs.readFileSync(path.join(root, "js.json"), "utf8"),
  ) as ApiSurfaceMapping;
}
