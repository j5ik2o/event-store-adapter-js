/**
 * The project structure a TypeScript rule decides dependencies against: the packages the root
 * `tsconfig.json` references, and the module aliases each package's `tsconfig.json` states.
 *
 * The configs are read with the compiler the launch classified, the same one that decided the
 * project is inside the supported settings, so the aliases are the ones that project resolves with.
 * Compiler API values never leave this module.
 */

import { join, resolve } from "node:path";
import { ToolUnavailableError } from "../../project/context.ts";
import { type TypeScriptExtractorOutcome, typeScriptExtractorIssue, verifiedCompilerOf } from "../compiler/launch.ts";
import { parseConfig, Refusal, referencedPackageRoots } from "../compiler/settings.ts";

/** One `paths` entry: the pattern a specifier is matched against and the absolute targets it maps to. */
interface PathAlias {
  readonly pattern: string;
  readonly targets: readonly string[];
}

export interface TypeScriptPackageConfig {
  /** The absolute package root, the directory holding its `tsconfig.json`. */
  readonly root: string;
  readonly aliases: readonly PathAlias[];
  /** Whether the package's settings state `baseUrl`, which resolves bare specifiers against a directory. */
  readonly base_url: boolean;
}

interface TypeScriptProject {
  readonly packages: readonly TypeScriptPackageConfig[];
}

/**
 * Reads the project at `workspaceRoot` with the compiler `extractor` was classified with. A launch
 * that is not ready, and a config the compiler refuses, stop the inspection as the facts do.
 */
export function readTypeScriptProject(extractor: TypeScriptExtractorOutcome, workspaceRoot: string): TypeScriptProject {
  if (extractor.kind !== "ready") throw new ToolUnavailableError(typeScriptExtractorIssue(extractor).message);
  const api = verifiedCompilerOf(extractor);
  const root = resolve(workspaceRoot);
  try {
    return {
      packages: referencedPackageRoots(api, root).map((packageRoot) => {
        const options = parseConfig(api, join(packageRoot, "tsconfig.json"), `${packageRoot}/tsconfig.json`).options;
        const paths = options.paths ?? {};
        // The compiler resolves `paths` against the directory of the config that states them, which
        // an inherited config can place elsewhere; it records that directory beside the options.
        const base = options.pathsBasePath;
        if (Object.keys(paths).length > 0 && typeof base !== "string")
          throw new ToolUnavailableError(
            `${packageRoot}/tsconfig.json states paths without a directory to resolve them`,
          );
        return {
          root: packageRoot,
          aliases: Object.entries(paths).map(([pattern, targets]) => ({
            pattern,
            targets: targets.map((target) => resolve(String(base), target)),
          })),
          base_url: options.baseUrl !== undefined,
        };
      }),
    };
  } catch (error) {
    if (error instanceof Refusal)
      throw new ToolUnavailableError(
        `the TypeScript project settings cannot be read at ${error.subject}: ${error.message}`,
      );
    throw error;
  }
}
