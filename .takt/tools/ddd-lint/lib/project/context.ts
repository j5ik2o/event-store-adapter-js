/**
 * The project the checks run against: its root, the directory that holds its model files, and the
 * source files below the root.
 *
 * Reading the project never spawns a process, touches the network, or reads credentials.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FindingInput } from "../shared/findings.ts";

/** Where a project keeps its model files, relative to its root. */
export const MODEL_DIR = "docs/ddd";

export interface ProjectContext {
  /** The project root: the directory that holds `.ddd.toml`. */
  readonly root: string;
  /** The directory that holds `domain-model.yaml`, `aggregate-mapping.yaml` and `layer-structure.yaml`. */
  readonly modelDir: string;
  readonly budget_ms?: number;
}

/** One source file of the project, by its root-relative path and its absolute path. */
export interface SourceFile {
  path: string;
  repo?: string;
  is_directory: boolean;
  resolved_path?: string;
}

export interface CheckApi {
  readonly context: ProjectContext;
  elapsedMs(): number;
  budgetExceeded(): boolean;
  /** Throws BudgetExceededError when the soft budget has elapsed. */
  checkBudget(): void;
}

export interface CheckEvaluation {
  findings: FindingInput[];
  note?: string;
}

/** A bundled asset the checks need (the compiler, the Rust extractor) cannot be used. */
export class ToolUnavailableError extends Error {}
export class BudgetExceededError extends Error {}

export function projectContext(root: string, budgetMs?: number): ProjectContext {
  return { root, modelDir: join(root, MODEL_DIR), ...(budgetMs === undefined ? {} : { budget_ms: budgetMs }) };
}

export function checkApi(context: ProjectContext): CheckApi {
  const startedAt = Date.now();
  const exceeded = (): boolean => context.budget_ms !== undefined && Date.now() - startedAt > context.budget_ms;
  return {
    context,
    elapsedMs: () => Date.now() - startedAt,
    budgetExceeded: exceeded,
    checkBudget: () => {
      if (exceeded()) throw new BudgetExceededError();
    },
  };
}

/** Directories no check reads: dependencies, build output, and every directory starting with `.`. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "target", "dist", "build", "coverage", "out"]);

function collectFiles(dir: string, extensions: readonly string[], out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) collectFiles(full, extensions, out);
    } else if (entry.isFile() && (extensions.length === 0 || extensions.includes(extname(entry.name)))) {
      out.push(full);
    }
  }
}

/** Every source file below the project root with one of `extensions`, in path order. */
export function projectSources(context: ProjectContext, extensions: readonly string[]): SourceFile[] {
  if (!existsSync(context.root)) return [];
  const files: string[] = [];
  collectFiles(context.root, extensions, files);
  return files
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((full) => ({ path: relPath(context, full), is_directory: false, resolved_path: full }));
}

/** A path relative to the project root, with `/` separators, as findings report it. */
export function relPath(context: ProjectContext, absolute: string): string {
  return relative(context.root, absolute).split(sep).join("/");
}

export function finding(rule_id: string, file: string, message: string, line?: number): FindingInput {
  return { rule_id, file, message, ...(line === undefined ? {} : { line }) };
}

export function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** The model a document names in `model_ref`, resolved against the directory of the model files. */
export function resolveModelPath(modelDir: string, modelRef: string): string {
  return isAbsolute(modelRef) ? modelRef : resolve(join(modelDir, modelRef));
}
