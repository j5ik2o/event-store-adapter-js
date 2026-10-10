import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { listConformanceFiles } from "./conformance-file-lister";
import { parseConformanceJson } from "./conformance-json-parser";
import type { ConformanceJsonValue } from "./conformance-json-value";
import { readConformanceText } from "./conformance-text-reader";

// 検査用の写し。bigint はスキーマの上限（2^53 - 1）との大小が変わらない Number にする。
const toSchemaInstance = (value: ConformanceJsonValue): unknown => {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return (value as readonly ConformanceJsonValue[]).map(toSchemaInstance);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toSchemaInstance(v)]),
    );
  }
  return value;
};

export type ConformanceSchemaValidator = (
  format: string,
  value: ConformanceJsonValue,
  source: string,
) => void;

export function createConformanceSchemaValidator(
  root: string,
): ConformanceSchemaValidator {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  // $id は URL だが取得はしない（loadSchema を設定せず、全スキーマを手元で登録する）。
  listConformanceFiles(root)
    .filter((f) => /^schema\/[^/]+\.schema\.json$/.test(f))
    .forEach((f) => {
      const schema = parseConformanceJson(
        readConformanceText(path.join(root, f)),
        f,
        () => false,
      );
      ajv.addSchema(toSchemaInstance(schema) as object, f);
    });
  return (format, value, source) => {
    const validate = ajv.getSchema(`schema/${format}.schema.json`);
    if (validate === undefined) {
      throw new Error(`${source}: no schema for format "${format}"`);
    }
    if (!validate(toSchemaInstance(value))) {
      throw new Error(
        `${source}: schema violation: ${ajv.errorsText(validate.errors)}`,
      );
    }
  };
}
