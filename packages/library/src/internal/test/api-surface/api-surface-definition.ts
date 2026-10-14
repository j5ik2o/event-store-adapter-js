import * as fs from "node:fs";
import * as path from "node:path";

export type ApiSurfaceElement = Readonly<{
  name: string;
  type: string;
  required?: boolean;
}>;

export type ApiSurfaceDefinition = Readonly<{
  types: readonly Readonly<{
    name: string;
    type_parameters: readonly string[];
    elements: readonly ApiSurfaceElement[];
  }>[];
  store: Readonly<{
    type_parameters: readonly string[];
    operations: readonly Readonly<{
      name: string;
      inputs: readonly ApiSurfaceElement[];
      output: string;
    }>[];
  }>;
  error_categories: Readonly<{ names: readonly string[] }>;
}>;

export function loadApiSurfaceDefinition(root: string): ApiSurfaceDefinition {
  return JSON.parse(
    fs.readFileSync(path.join(root, "surface.json"), "utf8"),
  ) as ApiSurfaceDefinition;
}
