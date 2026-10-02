/**
 * Reads one model file of a project (`docs/ddd/*.yaml`) as a YAML mapping. The directory the file
 * sits in is where the `model_ref` it names resolves.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { FindingInput } from "./findings.ts";
import { isRecord } from "./yaml-read.ts";

export interface YamlDocument {
  readonly path: string;
  /** The directory the document sits in; `model_ref` resolves against it. */
  readonly modelDir: string;
  readonly text: string;
  /** The parsed document, before any format has been assumed. */
  readonly root: Readonly<Record<string, unknown>>;
}

export type YamlDocumentRead =
  | { readonly kind: "loaded"; readonly document: YamlDocument }
  | { readonly kind: "rejected"; readonly findings: readonly FindingInput[] };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readYamlDocument(path: string, ruleId: string): YamlDocumentRead {
  const refused = (message: string): YamlDocumentRead => ({
    kind: "rejected",
    findings: [{ rule_id: ruleId, file: path, message }],
  });
  if (!existsSync(path)) return refused(`${basename(path)} not found: ${path}`);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return refused(`failed to read ${path}: ${errorMessage(error)}`);
  }
  let root: unknown;
  try {
    root = Bun.YAML.parse(text);
  } catch (error) {
    return refused(`failed to parse ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(root)) return refused(`${path} must hold a YAML mapping`);
  return { kind: "loaded", document: { path, modelDir: dirname(resolve(path)), text, root } };
}
