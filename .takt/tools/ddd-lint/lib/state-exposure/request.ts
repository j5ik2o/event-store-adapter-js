import {
  array,
  ContractError,
  canonicalJson,
  digest,
  integer,
  jsonCopy,
  nonempty,
  record,
  requireValue,
  scalarCompare,
} from "./canonical.ts";
import type {
  InspectionRequest,
  JsonValue,
  Language,
  RequestPreparation,
  SourceSnapshot,
  Target,
  ToolVersion,
} from "./contract.ts";
import { RULE_ID, SCHEMA_VERSION } from "./contract.ts";

function path(value: unknown, subject: string): string {
  const name = nonempty(value, subject);
  requireValue(
    !name.includes("\\") &&
      !name.includes("\0") &&
      name.split("/").every((part) => part && part !== "." && part !== ".."),
    subject,
    "Expected a relative POSIX path without empty or dot segments.",
  );
  return name;
}

function target(value: unknown, language: Language, subject: string): Target {
  const item = record(value, subject);
  const file = path(item.file, `${subject}.file`);
  const declarationPath = array(item.declarationPath, `${subject}.declarationPath`, 1).map((name, i) =>
    nonempty(name, `${subject}.declarationPath.${i}`),
  );
  const representation = item.representation;
  requireValue(
    language === "rust"
      ? representation === "rust-struct"
      : representation === "ts-class" || representation === "ts-companion",
    `${subject}.representation`,
    "Representation does not match language.",
  );
  return { file, declarationPath, representation: representation as Target["representation"] };
}

function tools(value: unknown, subject: string, ordered: boolean): ToolVersion[] {
  const items = array(value, subject, 1).map((value, i) => {
    const item = record(value, `${subject}.${i}`);
    return {
      name: nonempty(item.name, `${subject}.${i}.name`),
      version: nonempty(item.version, `${subject}.${i}.version`),
    };
  });
  uniqueNames(
    items.map((item) => item.name),
    subject,
    ordered,
  );
  return items.sort((a, b) => scalarCompare(a.name, b.name));
}

function uniqueNames(names: string[], subject: string, ordered: boolean): void {
  requireValue(new Set(names).size === names.length, subject, "Duplicate identifiers.");
  if (ordered)
    requireValue(
      names.every((name, i) => i === 0 || scalarCompare(names[i - 1], name) < 0),
      subject,
      "Expected Unicode scalar order.",
    );
}

function base(value: unknown, subject: string, ordered: boolean) {
  const item = record(jsonCopy(value, subject), subject);
  requireValue(item.language === "rust" || item.language === "typescript", `${subject}.language`, "Unknown language.");
  const language: Language = item.language;
  return {
    item,
    language,
    target: target(item.target, language, `${subject}.target`),
    settings: record(item.settings, `${subject}.settings`) as { readonly [key: string]: JsonValue },
    toolchain: tools(item.toolchain, `${subject}.toolchain`, ordered),
  };
}

function snapshot(sourcePath: string, content: string): SourceSnapshot {
  const bytes = new TextEncoder().encode(content);
  const lineStarts = [0];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13) {
      if (bytes[i + 1] === 10) i++;
      lineStarts.push(i + 1);
    } else if (bytes[i] === 10) lineStarts.push(i + 1);
    else if (bytes[i] === 0xe2 && bytes[i + 1] === 0x80 && (bytes[i + 2] === 0xa8 || bytes[i + 2] === 0xa9)) {
      i += 2;
      lineStarts.push(i + 1);
    }
  }
  return { path: sourcePath, sha256: digest(content), byteLength: bytes.length, lineStarts };
}

function validateSourceTargets(sources: SourceSnapshot[], selected: Target, subject: string, ordered: boolean): void {
  uniqueNames(
    sources.map((source) => source.path),
    `${subject}.sources`,
    ordered,
  );
  requireValue(
    sources.some((source) => source.path === selected.file),
    `${subject}.target.file`,
    "Target file is not a source.",
  );
}

function identify(fields: Omit<InspectionRequest, "requestIdentity">): InspectionRequest {
  return { ...fields, requestIdentity: digest(canonicalJson(fields as unknown as JsonValue)) };
}

export function prepareInspectionRequest(input: unknown): RequestPreparation {
  try {
    const values = base(input, "input", false);
    const sources = array(values.item.sources, "input.sources", 1).map((value, i) => {
      const item = record(value, `input.sources.${i}`);
      const sourcePath = path(item.path, `input.sources.${i}.path`);
      requireValue(typeof item.content === "string", `input.sources.${i}.content`, "Expected source text.");
      return snapshot(sourcePath, item.content);
    });
    validateSourceTargets(sources, values.target, "input", false);
    sources.sort((a, b) => scalarCompare(a.path, b.path));
    return {
      kind: "prepared",
      request: identify({
        schemaVersion: SCHEMA_VERSION,
        ruleId: RULE_ID,
        language: values.language,
        target: values.target,
        settings: values.settings,
        toolchain: values.toolchain,
        sources,
      }),
    };
  } catch (error) {
    if (error instanceof ContractError) return { kind: "input-rejected", issues: [error.issue] };
    throw error;
  }
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateSnapshot(value: unknown, subject: string): SourceSnapshot {
  const item = record(value, subject);
  const sourcePath = path(item.path, `${subject}.path`);
  requireValue(isDigest(item.sha256), `${subject}.sha256`, "Invalid source digest.");
  const byteLength = integer(item.byteLength, `${subject}.byteLength`);
  const lineStarts = array(item.lineStarts, `${subject}.lineStarts`, 1).map((value, i) =>
    integer(value, `${subject}.lineStarts.${i}`),
  );
  requireValue(
    lineStarts[0] === 0 &&
      lineStarts.every((start, i) => start <= byteLength && (i === 0 || start > lineStarts[i - 1])),
    `${subject}.lineStarts`,
    "Line starts must begin at zero and increase within the source.",
  );
  return { path: sourcePath, sha256: item.sha256, byteLength, lineStarts };
}

export function validateRequest(request: unknown): InspectionRequest {
  const values = base(request, "request", true);
  requireValue(values.item.schemaVersion === SCHEMA_VERSION, "request.schemaVersion", "Unknown request version.");
  requireValue(values.item.ruleId === RULE_ID, "request.ruleId", "Unknown rule.");
  requireValue(isDigest(values.item.requestIdentity), "request.requestIdentity", "Invalid request identity.");
  const sources = array(values.item.sources, "request.sources", 1).map((value, i) =>
    validateSnapshot(value, `request.sources.${i}`),
  );
  validateSourceTargets(sources, values.target, "request", true);
  const expected = identify({
    schemaVersion: SCHEMA_VERSION,
    ruleId: RULE_ID,
    language: values.language,
    target: values.target,
    sources,
    settings: values.settings,
    toolchain: values.toolchain,
  });
  requireValue(
    expected.requestIdentity === values.item.requestIdentity,
    "request.requestIdentity",
    "Request identity does not match its contents.",
  );
  return expected;
}
