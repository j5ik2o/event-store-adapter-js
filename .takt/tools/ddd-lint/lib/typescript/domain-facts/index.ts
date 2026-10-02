/**
 * The facts every TypeScript rule decides on: what each file declares, the members and visibility
 * of those declarations, what it imports and exports (type-only ones told apart), what it calls and
 * what it constructs, and what it leaves unresolved.
 *
 * The launch classification is the one in `compiler/launch.ts`; this module owns the parse of the
 * given sources and the terminal that turns an extraction these facts cannot be read from into a
 * stopped inspection. Compiler API nodes never leave it: a rule reads plain records.
 *
 * A file whose syntax the compiler rejects has no record, never an empty one, because "this file
 * declares nothing" is exactly the answer an unread file must not give.
 */

import type ts from "typescript";
import { ToolUnavailableError } from "../../project/context.ts";
import { type TypeScriptExtractorOutcome, typeScriptExtractorIssue, verifiedCompilerOf } from "../compiler/launch.ts";
import type { CompilerApi } from "../compiler/settings.ts";
import type { TypeScriptFactSet, TypeScriptFileFacts, TypeScriptSourceFile } from "./contract.ts";
import { extractFileFacts } from "./extract.ts";

export { COLLECTION_MUTATORS } from "./bodies.ts";
export type {
  CallFact,
  ConstructionFact,
  DeclarationFact,
  DeclarationKind,
  ExportFact,
  ExportName,
  HeritageFact,
  ImportBinding,
  ImportFact,
  InitializerFact,
  KeyedLiteralFact,
  LiteralForm,
  MemberFact,
  ParamFact,
  Span,
  TypeScriptFactSet,
  TypeScriptFileFacts,
  TypeScriptSourceFile,
  UnresolvedFact,
  UnresolvedReason,
  VariableBinding,
  Visibility,
  WriteFact,
} from "./contract.ts";

type TypeScriptFactResult =
  | { readonly kind: "facts"; readonly facts: TypeScriptFactSet }
  | { readonly kind: "unavailable"; readonly detail: string };

/** One source as the compiler read it, with the syntax diagnostics it reported for it. */
interface ParsedSource {
  readonly file: ts.SourceFile;
  readonly diagnostics: readonly ts.Diagnostic[];
}

/**
 * Every source is parsed from the given text alone: no library, no module resolution, no ambient
 * types and no emit. Each gets a path of its own inside the program so a workspace path the
 * compiler would treat differently by its extension never changes how a file is parsed.
 */
function parse(api: CompilerApi, sources: readonly TypeScriptSourceFile[]): ParsedSource[] {
  const paths = sources.map((entry, index) => `/facts/${index}${entry.file.endsWith(".tsx") ? ".tsx" : ".ts"}`);
  const texts = new Map(paths.map((path, index) => [path, sources[index].source]));
  const host: ts.CompilerHost = {
    getSourceFile: (file, languageVersion) => {
      const text = texts.get(file);
      return text === undefined ? undefined : api.createSourceFile(file, text, languageVersion, true);
    },
    getDefaultLibFileName: () => "/facts/lib.d.ts",
    writeFile: () => {
      throw new Error("source emission forbidden");
    },
    getCurrentDirectory: () => "/facts",
    getDirectories: () => [],
    fileExists: (file) => texts.has(file),
    readFile: (file) => texts.get(file),
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = api.createProgram(
    paths,
    { noLib: true, noResolve: true, types: [], noEmit: true, target: api.ScriptTarget.ESNext },
    host,
  );
  return paths.map((path) => {
    const file = program.getSourceFile(path);
    if (!file) throw new Error(`the compiler did not read ${path}`);
    return { file, diagnostics: program.getSyntacticDiagnostics(file) };
  });
}

/** The answer is keyed by file, so a request naming one file twice has no answer, whatever each text parses to. */
function requireDistinctFiles(sources: readonly TypeScriptSourceFile[]): void {
  const named = new Set<string>();
  for (const { file } of sources) {
    if (named.has(file)) throw new Error(`the request names ${file} twice`);
    named.add(file);
  }
}

function extract(api: CompilerApi, sources: readonly TypeScriptSourceFile[]): TypeScriptFactSet {
  requireDistinctFiles(sources);
  const files = new Map<string, TypeScriptFileFacts>();
  const notes = new Set<string>();
  for (const [index, parsed] of parse(api, sources).entries()) {
    const path = sources[index].file;
    const [syntaxError] = parsed.diagnostics;
    if (syntaxError) {
      if (syntaxError.start === undefined) throw new Error(`a syntax diagnostic of ${path} has no position`);
      notes.add(
        `domain-facts.unresolved: ${path}:${parsed.file.getLineAndCharacterOfPosition(syntaxError.start).line + 1} syntax-error`,
      );
      continue;
    }
    const facts = extractFileFacts(api, parsed.file);
    for (const item of facts.unresolved) notes.add(`domain-facts.unresolved: ${path}:${item.line} ${item.reason}`);
    files.set(path, facts);
  }
  return { files, notes: [...notes].sort() };
}

/**
 * Extracts the facts of `sources` with the classified compiler. Any failure of the extraction itself
 * is reported as one unavailable result rather than as a partial fact set.
 */
function readTypeScriptFacts(api: CompilerApi, sources: readonly TypeScriptSourceFile[]): TypeScriptFactResult {
  if (sources.length === 0) return { kind: "facts", facts: { files: new Map(), notes: [] } };
  try {
    return { kind: "facts", facts: extract(api, sources) };
  } catch (error) {
    return {
      kind: "unavailable",
      detail: `the TypeScript fact extraction did not complete: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The one place a TypeScript extractor these facts cannot be read from becomes a stopped inspection.
 *
 * A launch classified as unusable and an extraction that did not complete both reach the same
 * terminal, so neither ever turns into a verdict. Every entry that decides on these facts converts
 * through here, as the Rust entries convert through `requireDomainFacts`.
 */
export function requireTypeScriptFacts(
  extractor: TypeScriptExtractorOutcome,
  sources: readonly TypeScriptSourceFile[],
): TypeScriptFactSet {
  if (extractor.kind !== "ready") throw new ToolUnavailableError(typeScriptExtractorIssue(extractor).message);
  const result = readTypeScriptFacts(verifiedCompilerOf(extractor), sources);
  if (result.kind === "unavailable") throw new ToolUnavailableError(result.detail);
  return result.facts;
}
