import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ConformanceCase } from "./conformance-case";
import type { ConformanceData } from "./conformance-data";
import { listConformanceFiles } from "./conformance-file-lister";
import { expandGenerators } from "./conformance-generators";
import { parseConformanceJson } from "./conformance-json-parser";
import type { ConformanceJsonValue } from "./conformance-json-value";
import { isSeqNrPath } from "./conformance-number-paths";
import { parseEpochNanos, parseOccurredAtEpochNanos } from "./conformance-time";

const SUPPORTED_VERSION = "1.0.0";
const NON_VALUE_KEYS = new Set(["payload", "aggregate", "binary_json"]);

type JsonRecord = { readonly [key: string]: ConformanceJsonValue };
type CaseFormat = ConformanceCase["format"];

const isRecord = (v: ConformanceJsonValue | undefined): v is JsonRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const expectedFormat = (file: string): string | undefined => {
  const parts = file.split("/");
  const isJson = file.endsWith(".json");
  if (file === "coverage.json") return "coverage";
  if (file === "manifest.json") return "manifest";
  if (parts[0] === "schema" && parts.length === 2 && isJson) return "schema";
  if (file === "dynamodb/layout.json") return "layout";
  if (parts[0] === "dynamodb" && parts.length === 2 && isJson) {
    return "scenarios";
  }
  if (parts[0] === "values" && parts.length === 2 && isJson) return "values";
  if (parts[0] === "scenarios" && isJson) return "scenarios";
  return undefined;
};

const convertScenarioTimes = (
  value: ConformanceJsonValue,
): ConformanceJsonValue => {
  if (Array.isArray(value)) {
    return (value as readonly ConformanceJsonValue[]).map(convertScenarioTimes);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => {
      if (NON_VALUE_KEYS.has(key)) {
        return [key, v];
      }
      if (key === "occurred_at" && typeof v === "string" && /^\d{4}-/.test(v)) {
        return [key, parseOccurredAtEpochNanos(v)];
      }
      return [key, convertScenarioTimes(v)];
    }),
  );
};

const convertValuesTimes = (body: JsonRecord): JsonRecord => {
  const input = isRecord(body.input) ? body.input : undefined;
  const expected = isRecord(body.expect) ? body.expect : undefined;
  const convertedInput =
    input !== undefined && typeof input.epoch_nanoseconds === "string"
      ? {
          ...input,
          epoch_nanoseconds: parseEpochNanos(input.epoch_nanoseconds),
        }
      : input;
  const convertedExpect =
    expected !== undefined &&
    body.operation === "validateOccurredAt" &&
    typeof expected.value === "string"
      ? { ...expected, value: parseEpochNanos(expected.value) }
      : expected;
  return {
    ...body,
    ...(convertedInput === undefined ? {} : { input: convertedInput }),
    ...(convertedExpect === undefined ? {} : { expect: convertedExpect }),
  };
};

const toCase = (
  raw: ConformanceJsonValue,
  source: string,
  format: CaseFormat,
): ConformanceCase => {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !Array.isArray(raw.rules)
  ) {
    throw new Error(`${source}: case must have an id and rules`);
  }
  const expanded = expandGenerators(raw);
  const body =
    format === "values"
      ? convertValuesTimes(expanded as JsonRecord)
      : convertScenarioTimes(expanded);
  return {
    id: raw.id,
    rules: raw.rules as readonly string[],
    source,
    format,
    body,
  };
};

export function loadConformanceData(root: string): ConformanceData {
  const files = listConformanceFiles(root);
  const cases = files
    .filter((file) => file.endsWith(".json"))
    .flatMap((file): readonly ConformanceCase[] => {
      const format = expectedFormat(file);
      if (format === undefined) {
        throw new Error(`${file}: unexpected json file`);
      }
      const parsed = parseConformanceJson(
        readFileSync(path.join(root, file), "utf8"),
        file,
        (p) => isSeqNrPath(format, p),
      );
      if (format === "schema") {
        return [];
      }
      if (
        !isRecord(parsed) ||
        parsed.format !== format ||
        parsed.version !== SUPPORTED_VERSION
      ) {
        throw new Error(
          `${file}: format must be "${format}" and version "${SUPPORTED_VERSION}"`,
        );
      }
      if (
        format !== "values" &&
        format !== "scenarios" &&
        format !== "layout"
      ) {
        return [];
      }
      if (!Array.isArray(parsed.cases)) {
        throw new Error(`${file}: cases must be an array`);
      }
      return (parsed.cases as readonly ConformanceJsonValue[]).map((c) =>
        toCase(c, file, format),
      );
    });
  const ids = cases.map((c) => c.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new Error(`duplicate case id: ${duplicate}`);
  }
  return { version: SUPPORTED_VERSION, files, cases };
}
