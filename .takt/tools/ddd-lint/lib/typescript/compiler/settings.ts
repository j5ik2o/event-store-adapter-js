/**
 * The one definition of the Compiler API version and the project compiler settings TypeScript
 * inspections support, shared by every TypeScript entry.
 *
 * The Compiler API is passed in rather than imported: the error-contract entry reads its settings
 * with the development dependency, and the fact extraction with the compiler the distribution
 * carries. Both must refuse exactly the same projects, so the range is stated here once.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type ts from "typescript";
import { TYPESCRIPT_LANGUAGE_TARGETS, type TypeScriptLanguageTarget } from "../../error-contract/contract.ts";

export type CompilerApi = typeof ts;

export const SUPPORTED_COMPILER_API_VERSION = "6.0.3";

/** A project condition outside the supported range, as the reason code it is reported under. */
export class Refusal extends Error {
  constructor(
    readonly code: "tool-unavailable" | "unsupported-syntax",
    readonly subject: string,
    message: string,
  ) {
    super(message);
  }
}
export function unreadable(subject: string, message: string): never {
  throw new Refusal("tool-unavailable", subject, message);
}
export function notModelled(subject: string, message: string): never {
  throw new Refusal("unsupported-syntax", subject, message);
}

export function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value.length) notModelled(subject, "Expected a nonempty string.");
  return value;
}

interface ParsedConfig {
  readonly options: ts.CompilerOptions;
  readonly references: readonly string[];
}
export function parseConfig(api: CompilerApi, path: string, subject: string): ParsedConfig {
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: (directory, extensions, exclude, include, depth) =>
      api.sys.readDirectory(directory, extensions, exclude, include, depth),
    fileExists: (file) => existsSync(file),
    readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
  };
  if (!existsSync(path)) unreadable(subject, `${path} is not there.`);
  const read = api.readConfigFile(path, (file) => host.readFile(file));
  if (read.error) unreadable(subject, api.flattenDiagnosticMessageText(read.error.messageText, " "));
  const parsed = api.parseJsonConfigFileContent(read.config, host, dirname(path), undefined, path);
  if (parsed.errors.length) unreadable(subject, api.flattenDiagnosticMessageText(parsed.errors[0].messageText, " "));
  return {
    options: parsed.options,
    references: (parsed.projectReferences ?? []).map((entry) => packageRoot(entry.path, subject)),
  };
}

/**
 * The package root a project reference names. A reference may name the package's directory or the
 * config file itself; both reach the same package when that file is its `tsconfig.json`. A reference
 * to a config file of another name would have the package read under settings its `tsconfig.json`
 * does not state, so it is refused rather than silently replaced by that file.
 */
function packageRoot(reference: string, subject: string): string {
  if (!existsSync(reference) || !statSync(reference).isFile()) return reference;
  if (basename(reference) !== "tsconfig.json")
    notModelled(`${subject}.references`, `${basename(reference)} is not the package's tsconfig.json.`);
  return dirname(reference);
}

/** The compiler settings a package states, including everything its config inherits. */
export interface CompilerSettings {
  readonly module: "esnext";
  readonly moduleResolution: "bundler";
  readonly target: TypeScriptLanguageTarget;
  readonly resolutionConditions: readonly string[];
}

/**
 * The compiler setting each supported target name stands for. The names are stated rather than read
 * back from the enum, whose reverse mapping names the value ESNext shares with `Latest` as `Latest`.
 */
const SCRIPT_TARGET: Record<TypeScriptLanguageTarget, keyof typeof ts.ScriptTarget> = {
  es2017: "ES2017",
  es2018: "ES2018",
  es2019: "ES2019",
  es2020: "ES2020",
  es2021: "ES2021",
  es2022: "ES2022",
  es2023: "ES2023",
  es2024: "ES2024",
  es2025: "ES2025",
  esnext: "ESNext",
};
export function scriptTarget(api: CompilerApi, target: TypeScriptLanguageTarget): ts.ScriptTarget {
  return api.ScriptTarget[SCRIPT_TARGET[target]];
}

/**
 * Each setting has the one value — for the target, one of the range — the inspections model; a
 * setting left unstated is refused too, rather than read under the compiler's default.
 */
export function compilerSettings(api: CompilerApi, options: ts.CompilerOptions, subject: string): CompilerSettings {
  if (options.module !== api.ModuleKind.ESNext) notModelled(`${subject}.module`, "Unsupported module kind.");
  if (options.moduleResolution !== api.ModuleResolutionKind.Bundler)
    notModelled(`${subject}.moduleResolution`, "Unsupported module resolution.");
  const target = TYPESCRIPT_LANGUAGE_TARGETS.find((name) => scriptTarget(api, name) === options.target);
  if (target === undefined) notModelled(`${subject}.target`, "Unsupported language target.");
  if (options.strict !== true) notModelled(`${subject}.strict`, "Expected a project that type checks strictly.");
  return {
    module: "esnext",
    moduleResolution: "bundler",
    target,
    resolutionConditions: (options.customConditions ?? []).map((name, index) =>
      text(name, `${subject}.customConditions.${index}`),
    ),
  };
}

/**
 * The packages the root `tsconfig.json` of the project at `workspaceRoot` references, as absolute
 * package roots. A project that references none is refused: there is no package to inspect.
 */
export function referencedPackageRoots(api: CompilerApi, workspaceRoot: string): readonly string[] {
  const config = parseConfig(api, join(workspaceRoot, "tsconfig.json"), "tsconfig.json");
  if (!config.references.length) notModelled("tsconfig.json.references", "The project references no package.");
  return config.references;
}

/** The one set of compiler settings every package states; packages that state different ones are refused. */
export function sharedCompilerSettings(settings: readonly CompilerSettings[]): CompilerSettings {
  const distinct = new Set(settings.map((value) => JSON.stringify(value)));
  if (distinct.size !== 1)
    notModelled("tsconfig.json.compilerOptions", "The packages of this project state different compiler settings.");
  return settings[0];
}

/**
 * The compiler settings of the project at `workspaceRoot`: its root `tsconfig.json` references at
 * least one package, every referenced package's `tsconfig.json` states the supported settings, and
 * all of them state the same ones. Throws a `Refusal` for the first condition that does not hold.
 */
export function readCompilerCondition(api: CompilerApi, workspaceRoot: string): CompilerSettings {
  const root = resolve(workspaceRoot);
  const settings = referencedPackageRoots(api, root).map((reference) => {
    const subject = `${relative(root, reference).split(sep).join("/")}/tsconfig.json`;
    return compilerSettings(api, parseConfig(api, join(reference, "tsconfig.json"), subject).options, subject);
  });
  return sharedCompilerSettings(settings);
}
