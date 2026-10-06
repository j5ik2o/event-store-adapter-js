import { lstatSync, readdirSync } from "node:fs";
import * as path from "node:path";

const walk = (root: string, relative: string): readonly string[] =>
  readdirSync(path.join(root, relative)).flatMap((name) => {
    const entry = relative === "" ? name : `${relative}/${name}`;
    const stat = lstatSync(path.join(root, entry));
    if (stat.isSymbolicLink()) {
      throw new Error(`${entry}: symbolic links are not allowed`);
    }
    return stat.isDirectory() ? walk(root, entry) : [entry];
  });

export function listConformanceFiles(root: string): readonly string[] {
  return [...walk(root, "")].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
