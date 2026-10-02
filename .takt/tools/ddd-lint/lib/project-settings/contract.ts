/** Language-neutral project settings: the vocabulary, the validated selection, and the rejection shape. */

export type ProjectLanguage = "rust" | "typescript";
export type RustModuleLayout = "file" | "mod-rs";
export type TypeScriptModuleLayout = "named-file" | "index-file";
export type TypeScriptCodeRepresentation = "class" | "companion";

export interface RustSelection {
  readonly moduleLayout: RustModuleLayout;
}
export interface TypeScriptSelection {
  readonly moduleLayout: TypeScriptModuleLayout;
  readonly codeRepresentation: TypeScriptCodeRepresentation;
}
/** A language that is not in use carries no choice at all, so nothing can be inferred for it. */
export interface ProjectSelection {
  readonly languages: readonly ProjectLanguage[];
  readonly rust: RustSelection | null;
  readonly typescript: TypeScriptSelection | null;
}

export const DOCUMENT_NAME = ".ddd.toml";
export const LANGUAGES_KEY = "languages";
export const LANGUAGES: readonly ProjectLanguage[] = ["rust", "typescript"];
export const RUST_MODULE_LAYOUTS: readonly RustModuleLayout[] = ["file", "mod-rs"];
export const TYPESCRIPT_MODULE_LAYOUTS: readonly TypeScriptModuleLayout[] = ["named-file", "index-file"];
export const TYPESCRIPT_CODE_REPRESENTATIONS: readonly TypeScriptCodeRepresentation[] = ["class", "companion"];
/** Owned by the aggregate mapping document; project settings never hold or overwrite them. */
export const AGGREGATE_MAPPING_KEYS: readonly string[] = ["programming_model", "persistence_method"];

export type SettingsRejectionReason =
  | "file-absent"
  | "unreadable"
  | "malformed-syntax"
  | "nested-config-found"
  | "aggregate-mapping-leak"
  | "duplicate-choice-on-axis"
  | "unknown-key-or-value"
  | "type-mismatch"
  | "required-choice-missing";

/** Carries no line or column: the TOML parser reports no positions, so any position would be invented. */
export interface SettingsRejection {
  readonly reason: SettingsRejectionReason;
  readonly file: string;
  readonly subject: string | null;
  readonly missing: readonly string[];
  readonly rejectedDocuments: readonly string[];
  readonly detail: string;
}

export type ReadOutcome =
  | { readonly kind: "validated"; readonly selection: ProjectSelection }
  | { readonly kind: "rejected"; readonly rejection: SettingsRejection };

export function rejectionAtKey(
  file: string,
  reason: SettingsRejectionReason,
  subject: string,
  detail: string,
): SettingsRejection {
  return { reason, file, subject, missing: [], rejectedDocuments: [], detail };
}

export function rejectionForDocument(file: string, reason: SettingsRejectionReason, detail: string): SettingsRejection {
  return { reason, file, subject: null, missing: [], rejectedDocuments: [], detail };
}

export function rejectionForMissing(
  file: string,
  reason: SettingsRejectionReason,
  missing: readonly string[],
  detail: string,
): SettingsRejection {
  return { reason, file, subject: null, missing, rejectedDocuments: [], detail };
}

export function rejectionForNested(
  file: string,
  rejectedDocuments: readonly string[],
  detail: string,
): SettingsRejection {
  return { reason: "nested-config-found", file, subject: null, missing: [], rejectedDocuments, detail };
}

export function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads only own keys so an inherited property can never stand in for a declared setting. */
export function entryOf(table: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

