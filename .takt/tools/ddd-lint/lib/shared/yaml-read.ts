/**
 * Reading the shape of a parsed YAML node, shared by the artifact readers.
 *
 * Every helper reports what it refuses and returns `undefined`; nothing is coerced, defaulted or
 * dropped, so a key a document never stated is never mistaken for one it stated as empty. The rule
 * id a refusal carries belongs to the artifact rather than to the shape, so the report the caller
 * passes is what decides it.
 */

/** What a caller's finding report has to offer these helpers; each artifact's report supplies it. */
interface StructureReport {
  /** Records one defect in the shape of a value, under the artifact's own structure rule. */
  structure(message: string): void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads only own keys, so an inherited property can never stand in for a declared value. */
export function own(node: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(node, key) ? node[key] : undefined;
}

export function allDefined<T>(values: readonly (T | undefined)[]): values is T[] {
  return values.every((value) => value !== undefined);
}

/** An optional value as read: absent, or present with its value. A refused value reads as undefined. */
export type OptionalValue<T> = { readonly present: false } | { readonly present: true; readonly value: T };

export const ABSENT = { present: false } as const;

function refuse(report: StructureReport, message: string): undefined {
  report.structure(message);
  return undefined;
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export function readText(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string | undefined {
  const value = own(node, key);
  if (typeof value === "string" && value.length > 0) return value;
  return refuse(report, `${where}: "${key}" must be a non-empty string`);
}

export function readOptionalText(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): OptionalValue<string> | undefined {
  if (own(node, key) === undefined) return ABSENT;
  const value = readText(report, node, key, where);
  return value === undefined ? undefined : { present: true, value };
}

/** A flag the document either states as a boolean or does not state; `"true"` is neither. */
export function readOptionalBoolean(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): OptionalValue<boolean> | undefined {
  const value = own(node, key);
  if (value === undefined) return ABSENT;
  if (typeof value === "boolean") return { present: true, value };
  return refuse(report, `${where}: "${key}" must be true or false`);
}

export function readChoice<T extends string>(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  choices: readonly T[],
  where: string,
): T | undefined {
  const value = own(node, key);
  const chosen = choices.find((choice) => choice === value);
  if (chosen !== undefined) return chosen;
  return refuse(report, `${where}: "${key}" must be one of ${choices.join(", ")}`);
}

export function readOptionalChoice<T extends string>(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  choices: readonly T[],
  where: string,
): OptionalValue<T> | undefined {
  if (own(node, key) === undefined) return ABSENT;
  const value = readChoice(report, node, key, choices, where);
  return value === undefined ? undefined : { present: true, value };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

interface ListRule {
  readonly required: boolean;
  readonly minimum: number;
  /** An extra test each entry must pass, such as the grammar of a language's names. */
  readonly accepts?: (entry: string) => boolean;
}

export function readTextList(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  rule: ListRule,
): string[] | undefined {
  const value = own(node, key);
  if (value === undefined && !rule.required) return [];
  if (!Array.isArray(value)) return refuse(report, `${where}: "${key}" must be a list`);
  const entries = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0)
      return refuse(report, `${where}: "${key}[${index}]" must be a non-empty string`);
    if (rule.accepts !== undefined && !rule.accepts(entry))
      return refuse(
        report,
        `${where}: "${key}[${index}]" ${JSON.stringify(entry)} is not a valid name in this language`,
      );
    return entry;
  });
  if (entries.length < rule.minimum) return refuse(report, `${where}: "${key}" needs at least ${rule.minimum} entry`);
  return allDefined(entries) ? entries : undefined;
}

/** A list the document either states — empty included — or does not state at all. */
export function readOptionalTextList(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  rule: Omit<ListRule, "required">,
): OptionalValue<string[]> | undefined {
  if (own(node, key) === undefined) return ABSENT;
  const value = readTextList(report, node, key, where, { ...rule, required: true });
  return value === undefined ? undefined : { present: true, value };
}

export function readNodes(
  report: StructureReport,
  node: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  required: boolean,
): Record<string, unknown>[] | undefined {
  const value = own(node, key);
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) return refuse(report, `${where}: "${key}" must be a list`);
  const entries = value.map((entry, index) =>
    isRecord(entry) ? entry : refuse(report, `${where}: "${key}[${index}]" must be a mapping`),
  );
  return allDefined(entries) ? entries : undefined;
}
