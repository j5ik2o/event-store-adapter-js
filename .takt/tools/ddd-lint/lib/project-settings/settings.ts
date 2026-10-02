/**
 * Turns a parsed document into one validated selection or one rejection. No file system access:
 * the meaning of the settings changes for different reasons than reading and writing them.
 */

import type {
  ProjectLanguage,
  ProjectSelection,
  ReadOutcome,
  RustModuleLayout,
  SettingsRejection,
  TypeScriptCodeRepresentation,
  TypeScriptModuleLayout,
} from "./contract.ts";
import {
  AGGREGATE_MAPPING_KEYS,
  entryOf,
  isTable,
  LANGUAGES,
  LANGUAGES_KEY,
  RUST_MODULE_LAYOUTS,
  rejectionAtKey,
  rejectionForMissing,
  TYPESCRIPT_CODE_REPRESENTATIONS,
  TYPESCRIPT_MODULE_LAYOUTS,
} from "./contract.ts";

const TOP_LEVEL_KEYS: readonly string[] = [LANGUAGES_KEY, ...LANGUAGES];
const AXIS_KEYS: Record<ProjectLanguage, readonly string[]> = {
  rust: ["module_layout"],
  typescript: ["module_layout", "code_representation"],
};
const AXIS_VALUES: Record<string, readonly string[]> = {
  "rust.module_layout": RUST_MODULE_LAYOUTS,
  "typescript.module_layout": TYPESCRIPT_MODULE_LAYOUTS,
  "typescript.code_representation": TYPESCRIPT_CODE_REPRESENTATIONS,
};

function aggregateMappingKey(document: Record<string, unknown>): string | null {
  for (const key of AGGREGATE_MAPPING_KEYS) if (Object.hasOwn(document, key)) return key;
  for (const language of LANGUAGES) {
    const table = entryOf(document, language);
    if (!isTable(table)) continue;
    for (const key of AGGREGATE_MAPPING_KEYS) if (Object.hasOwn(table, key)) return `${language}.${key}`;
  }
  return null;
}


function languageRejection(document: Record<string, unknown>, file: string) {
  const unknownKey = Object.keys(document).find((key) => !TOP_LEVEL_KEYS.includes(key));
  if (unknownKey !== undefined)
    return rejectionAtKey(file, "unknown-key-or-value", unknownKey, "this key is not part of the settings contract");
  const languages = entryOf(document, LANGUAGES_KEY);
  if (languages === undefined)
    return rejectionForMissing(
      file,
      "required-choice-missing",
      [LANGUAGES_KEY],
      "name the languages this project uses",
    );
  if (!Array.isArray(languages) || languages.some((name) => typeof name !== "string"))
    return rejectionAtKey(file, "type-mismatch", LANGUAGES_KEY, "expected an array of language names");
  if (languages.some((name) => !LANGUAGES.includes(name as ProjectLanguage)))
    return rejectionAtKey(file, "unknown-key-or-value", LANGUAGES_KEY, `known languages are ${LANGUAGES.join(", ")}`);
  if (languages.length === 0)
    return rejectionForMissing(
      file,
      "required-choice-missing",
      [LANGUAGES_KEY],
      "name the languages this project uses",
    );
  return null;
}

function tableRejection(document: Record<string, unknown>, enabled: ReadonlySet<ProjectLanguage>, file: string) {
  for (const language of LANGUAGES) {
    const table = entryOf(document, language);
    if (table === undefined) continue;
    if (!enabled.has(language))
      return rejectionAtKey(
        file,
        "unknown-key-or-value",
        language,
        `the [${language}] table is present but ${language} is not listed in ${LANGUAGES_KEY}`,
      );
    if (!isTable(table)) return rejectionAtKey(file, "type-mismatch", language, `expected the [${language}] table`);
    const unknownKey = Object.keys(table).find((key) => !AXIS_KEYS[language].includes(key));
    if (unknownKey !== undefined)
      return rejectionAtKey(
        file,
        "unknown-key-or-value",
        `${language}.${unknownKey}`,
        `${language} has no such choice axis`,
      );
  }
  return null;
}

type AxisOutcome =
  | { readonly kind: "chosen"; readonly chosen: Record<string, string>; readonly missing: readonly string[] }
  | { readonly kind: "rejected"; readonly rejection: SettingsRejection };

function readAxes(document: Record<string, unknown>, enabled: ReadonlySet<ProjectLanguage>, file: string): AxisOutcome {
  const chosen: Record<string, string> = {};
  const missing: string[] = [];
  for (const language of LANGUAGES) {
    if (!enabled.has(language)) continue;
    const table = entryOf(document, language);
    const axes = isTable(table) ? table : {};
    for (const key of AXIS_KEYS[language]) {
      const path = `${language}.${key}`;
      const allowed = AXIS_VALUES[path];
      const value = entryOf(axes, key);
      if (value === undefined) {
        missing.push(path);
        continue;
      }
      if (Array.isArray(value)) {
        const everyValueAllowed = value.every((item) => typeof item === "string" && allowed.includes(item));
        if (value.length >= 2 && everyValueAllowed)
          return {
            kind: "rejected",
            rejection: rejectionAtKey(file, "duplicate-choice-on-axis", path, "choose exactly one method on this axis"),
          };
        return {
          kind: "rejected",
          rejection: rejectionAtKey(file, "type-mismatch", path, `expected one of ${allowed.join(", ")}`),
        };
      }
      if (typeof value !== "string")
        return {
          kind: "rejected",
          rejection: rejectionAtKey(file, "type-mismatch", path, `expected one of ${allowed.join(", ")}`),
        };
      if (!allowed.includes(value))
        return {
          kind: "rejected",
          rejection: rejectionAtKey(file, "unknown-key-or-value", path, `known methods are ${allowed.join(", ")}`),
        };
      chosen[path] = value;
    }
  }
  return { kind: "chosen", chosen, missing };
}

/** One reason is selected in a fixed order, and the whole diagnostic is built from that single reason. */
export function validateProjectSettings(document: Record<string, unknown>, file: string): ReadOutcome {
  const leak = aggregateMappingKey(document);
  if (leak !== null)
    return {
      kind: "rejected",
      rejection: rejectionAtKey(
        file,
        "aggregate-mapping-leak",
        leak,
        "the aggregate execution model and persistence method belong to the aggregate mapping document",
      ),
    };

  const language = languageRejection(document, file);
  if (language !== null) return { kind: "rejected", rejection: language };

  const declared = entryOf(document, LANGUAGES_KEY) as readonly ProjectLanguage[];
  const enabled = new Set(declared);

  const table = tableRejection(document, enabled, file);
  if (table !== null) return { kind: "rejected", rejection: table };

  const axes = readAxes(document, enabled, file);
  if (axes.kind === "rejected") return { kind: "rejected", rejection: axes.rejection };
  if (axes.missing.length > 0)
    return {
      kind: "rejected",
      rejection: rejectionForMissing(
        file,
        "required-choice-missing",
        axes.missing,
        "every language in use needs each of its choices declared",
      ),
    };

  const selection: ProjectSelection = {
    languages: LANGUAGES.filter((name) => enabled.has(name)),
    rust: enabled.has("rust") ? { moduleLayout: axes.chosen["rust.module_layout"] as RustModuleLayout } : null,
    typescript: enabled.has("typescript")
      ? {
          moduleLayout: axes.chosen["typescript.module_layout"] as TypeScriptModuleLayout,
          codeRepresentation: axes.chosen["typescript.code_representation"] as TypeScriptCodeRepresentation,
        }
      : null,
  };
  return { kind: "validated", selection };
}
