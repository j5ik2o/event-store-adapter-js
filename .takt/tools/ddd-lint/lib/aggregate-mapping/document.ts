/** Reads the implementation mapping (`docs/ddd/aggregate-mapping.yaml`) of a project. */

import { readYamlDocument, type YamlDocument, type YamlDocumentRead } from "../shared/yaml-document.ts";
import { MAPPING_RULES } from "./contract.ts";

export type MappingDocument = YamlDocument;

export function readMappingDocument(path: string): YamlDocumentRead {
  return readYamlDocument(path, MAPPING_RULES.document);
}
