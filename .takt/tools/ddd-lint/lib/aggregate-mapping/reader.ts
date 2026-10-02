/**
 * Reads the shape of a mapping, before any model is consulted.
 *
 * The key set is closed at every level, so a crate or module left beside the business ids, a
 * compiler symbol id, a source position or an export table is refused rather than ignored. Names
 * under `code` are checked against the grammar of the language the entry declares. A value that
 * does not fit is reported; nothing is coerced, defaulted or dropped.
 */

import type { FindingInput } from "../shared/findings.ts";
import {
  ABSENT,
  allDefined,
  isRecord,
  type OptionalValue,
  own,
  readChoice,
  readNodes,
  readOptionalText,
  readText,
  readTextList,
} from "../shared/yaml-read.ts";
import {
  type AggregateMappingDraft,
  type CodeLocation,
  type DomainPackageMapping,
  type ErrorCaseMapping,
  MAPPING_LANGUAGES,
  type MappingDraft,
  type MappingLanguage,
  MappingReport,
  type OperationMapping,
  PERSISTENCE_METHODS,
  PROGRAMMING_MODELS,
  type ReplayMethodMapping,
} from "./contract.ts";
import { type LanguageSpelling, type NameTest, SPELLINGS } from "./language.ts";

const KEYS = {
  root: ["model_ref", "aggregate_mappings", "domain_packages"],
  aggregate: [
    "aggregate_ref",
    "programming_model",
    "persistence_method",
    "reference_ids",
    "replay_methods",
    "code",
    "operations",
  ],
  aggregateCode: ["language", "package", "module", "type", "ports", "repository"],
  replay: ["event_ref", "code"],
  replayCode: ["method"],
  operation: ["operation_ref", "code", "errors"],
  operationCode: ["method", "error_type", "success_type"],
  error: ["error_ref", "code"],
  errorCode: ["case"],
  package: ["term", "model_refs", "rationale", "code"],
  packageCode: ["language", "package", "module"],
} as const;

function structure(report: MappingReport, message: string): undefined {
  report.structure(message);
  return undefined;
}

function spellingOf(language: MappingLanguage | undefined): LanguageSpelling | undefined {
  return language === undefined ? undefined : SPELLINGS[language];
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Business wording: a term or a rationale says something only when it is more than blanks. */
function readBusinessText(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string | undefined {
  const value = own(node, key);
  if (typeof value === "string" && value.trim().length > 0) return value;
  return structure(report, `${where}: "${key}" must state the business wording`);
}

/**
 * A name spelled in the entry's language. Without a known language only its presence is checked;
 * the unknown language is reported where it is read.
 */
function readName(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  accepts: NameTest | undefined,
): string | undefined {
  const value = readText(report, node, key, where);
  if (value === undefined || accepts === undefined || accepts(value)) return value;
  return structure(report, `${where}: "${key}" ${JSON.stringify(value)} is not a valid name in this language`);
}

function readOptionalName(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  accepts: NameTest | undefined,
): OptionalValue<string> | undefined {
  if (own(node, key) === undefined) return ABSENT;
  const value = readName(report, node, key, where, accepts);
  return value === undefined ? undefined : { present: true, value };
}

/** A `code` mapping holding exactly the keys its owner may spell. */
function readCodeNode(
  report: MappingReport,
  owner: Readonly<Record<string, unknown>>,
  where: string,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  const code = own(owner, "code");
  if (!isRecord(code)) return structure(report, `${where}: "code" must be a mapping`);
  report.unknownKeys(code, allowed, `${where}.code`);
  return code;
}

// ---------------------------------------------------------------------------
// Code locations
// ---------------------------------------------------------------------------

function readLocation(
  report: MappingReport,
  code: Readonly<Record<string, unknown>>,
  where: string,
  language: MappingLanguage | undefined,
): CodeLocation | undefined {
  const spelling = spellingOf(language);
  const packageName = readName(report, code, "package", where, spelling?.isPackage);
  const module = readTextList(report, code, "module", where, {
    required: true,
    minimum: 0,
    accepts: spelling?.isModuleSegment,
  });
  if (language === undefined || packageName === undefined || module === undefined) return undefined;
  return { language, package: packageName, module };
}

function readLanguage(
  report: MappingReport,
  code: Readonly<Record<string, unknown>>,
  where: string,
): MappingLanguage | undefined {
  return readChoice(report, code, "language", MAPPING_LANGUAGES, where);
}

// ---------------------------------------------------------------------------
// Operations and error cases
// ---------------------------------------------------------------------------

function readErrorCase(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
  spelling: LanguageSpelling | undefined,
): ErrorCaseMapping | undefined {
  report.unknownKeys(node, KEYS.error, where);
  const errorRef = readText(report, node, "error_ref", where);
  const code = readCodeNode(report, node, where, KEYS.errorCode);
  const errorCase = code && readName(report, code, "case", `${where}.code`, spelling?.isErrorCase);
  if (errorRef === undefined || errorCase === undefined) return undefined;
  return { error_ref: errorRef, code: { case: errorCase } };
}

function readOperation(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
  spelling: LanguageSpelling | undefined,
): OperationMapping | undefined {
  report.unknownKeys(node, KEYS.operation, where);
  const operationRef = readText(report, node, "operation_ref", where);
  const code = readCodeNode(report, node, where, KEYS.operationCode);
  const method = code && readName(report, code, "method", `${where}.code`, spelling?.isIdentifier);
  const errorType = code && readName(report, code, "error_type", `${where}.code`, spelling?.isIdentifier);
  const successRead = code && readOptionalName(report, code, "success_type", `${where}.code`, spelling?.isIdentifier);
  const successType = successRead?.present ? successRead.value : undefined;
  if (code && successRead?.present === false && operationRef?.startsWith("command."))
    structure(report, `${where}.code: a command names its "success_type"`);
  const errors = readNodes(report, node, "errors", where, true)?.map((entry, index) =>
    readErrorCase(report, entry, `${where}.errors[${index}]`, spelling),
  );
  if (
    operationRef === undefined ||
    method === undefined ||
    errorType === undefined ||
    errors === undefined ||
    !allDefined(errors)
  )
    return undefined;
  return {
    operation_ref: operationRef,
    code: { method, error_type: errorType, ...(successType === undefined ? {} : { success_type: successType }) },
    errors,
  };
}

/**
 * The operations listed under `owner.operations`, with their names checked in `language`.
 */
export function readOperations(
  report: MappingReport,
  owner: Readonly<Record<string, unknown>>,
  where: string,
  language: MappingLanguage | undefined,
  required: boolean,
): OperationMapping[] | undefined {
  const spelling = spellingOf(language);
  const operations = readNodes(report, owner, "operations", where, required)?.map((entry, index) =>
    readOperation(report, entry, `${where}.operations[${index}]`, spelling),
  );
  return operations !== undefined && allDefined(operations) ? operations : undefined;
}

/** An optional type name in `code`, checked in `language`. */
export function readTypeName(
  report: MappingReport,
  code: Readonly<Record<string, unknown>>,
  where: string,
  language: MappingLanguage | undefined,
): OptionalValue<string> | undefined {
  return readOptionalName(report, code, "type", where, spellingOf(language)?.isIdentifier);
}

// ---------------------------------------------------------------------------
// Aggregates and packages
// ---------------------------------------------------------------------------

function readReplay(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
  spelling: LanguageSpelling | undefined,
): ReplayMethodMapping | undefined {
  report.unknownKeys(node, KEYS.replay, where);
  const eventRef = readText(report, node, "event_ref", where);
  const code = readCodeNode(report, node, where, KEYS.replayCode);
  const method = code && readName(report, code, "method", `${where}.code`, spelling?.isIdentifier);
  if (eventRef === undefined || method === undefined) return undefined;
  return { event_ref: eventRef, code: { method } };
}

interface AggregateCodeRead {
  /** Known whenever the language itself is valid, so the names below the aggregate can be checked. */
  readonly language: MappingLanguage | undefined;
  readonly code: AggregateMappingDraft["code"] | undefined;
}

function readAggregateCode(
  report: MappingReport,
  owner: Readonly<Record<string, unknown>>,
  where: string,
): AggregateCodeRead {
  const node = readCodeNode(report, owner, where, KEYS.aggregateCode);
  if (node === undefined) return { language: undefined, code: undefined };
  const codeWhere = `${where}.code`;
  const language = readLanguage(report, node, codeWhere);
  const location = readLocation(report, node, codeWhere, language);
  const type = readTypeName(report, node, codeWhere, language);
  const ports = readTextList(report, node, "ports", codeWhere, { required: false, minimum: 0 });
  const repository = readOptionalText(report, node, "repository", codeWhere);
  if (location === undefined || type === undefined || ports === undefined || repository === undefined)
    return { language, code: undefined };
  return {
    language,
    code: {
      ...location,
      ...(type.present ? { type: type.value } : {}),
      ports,
      ...(repository.present ? { repository: repository.value } : {}),
    },
  };
}

function readAggregate(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
): AggregateMappingDraft | undefined {
  report.unknownKeys(node, KEYS.aggregate, where);
  const aggregateRef = readText(report, node, "aggregate_ref", where);
  const programmingModel = readChoice(report, node, "programming_model", PROGRAMMING_MODELS, where);
  const persistenceMethod = readChoice(report, node, "persistence_method", PERSISTENCE_METHODS, where);
  const referenceIds = readTextList(report, node, "reference_ids", where, { required: true, minimum: 1 });
  const { language, code } = readAggregateCode(report, node, where);
  const spelling = spellingOf(language);
  const replayMethods = readNodes(report, node, "replay_methods", where, false)?.map((entry, index) =>
    readReplay(report, entry, `${where}.replay_methods[${index}]`, spelling),
  );
  const operations = readOperations(report, node, where, language, true);
  if (
    aggregateRef === undefined ||
    programmingModel === undefined ||
    persistenceMethod === undefined ||
    referenceIds === undefined ||
    code === undefined ||
    replayMethods === undefined ||
    !allDefined(replayMethods) ||
    operations === undefined
  )
    return undefined;
  return {
    aggregate_ref: aggregateRef,
    programming_model: programmingModel,
    persistence_method: persistenceMethod,
    reference_ids: referenceIds,
    replay_methods: replayMethods,
    code,
    operations,
  };
}

function readPackage(
  report: MappingReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
): DomainPackageMapping | undefined {
  report.unknownKeys(node, KEYS.package, where);
  const term = readBusinessText(report, node, "term", where);
  const modelRefs = readTextList(report, node, "model_refs", where, { required: true, minimum: 1 });
  const rationale = readBusinessText(report, node, "rationale", where);
  const code = readCodeNode(report, node, where, KEYS.packageCode);
  const location = code && readLocation(report, code, `${where}.code`, readLanguage(report, code, `${where}.code`));
  if (term === undefined || modelRefs === undefined || rationale === undefined || location === undefined)
    return undefined;
  return { term, model_refs: modelRefs, rationale, code: location };
}

type DraftRead =
  | { readonly kind: "read"; readonly draft: MappingDraft }
  | { readonly kind: "rejected"; readonly findings: readonly FindingInput[] };

/**
 * A root read into a draft mapping. Every finding names
 * `file`, the document the root was read from.
 */
export function readMappingDraft(root: Readonly<Record<string, unknown>>, file: string): DraftRead {
  const report = new MappingReport(file);
  report.unknownKeys(root, KEYS.root, "mapping");
  const modelRef = readText(report, root, "model_ref", "mapping");
  const aggregates = readNodes(report, root, "aggregate_mappings", "mapping", true)?.map((entry, index) =>
    readAggregate(report, entry, `aggregate_mappings[${index}]`),
  );
  const packages = readNodes(report, root, "domain_packages", "mapping", true)?.map((entry, index) =>
    readPackage(report, entry, `domain_packages[${index}]`),
  );
  if (
    report.findings.length > 0 ||
    modelRef === undefined ||
    aggregates === undefined ||
    !allDefined(aggregates) ||
    packages === undefined ||
    !allDefined(packages)
  )
    return { kind: "rejected", findings: report.findings };
  return {
    kind: "read",
    draft: {
      model_ref: modelRef,
      aggregate_mappings: aggregates,
      domain_packages: packages,
    },
  };
}
