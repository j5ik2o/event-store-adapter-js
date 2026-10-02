/** Reads the layer declaration (`docs/ddd/layer-structure.yaml`) of a project. */

import { readYamlDocument, type YamlDocument, type YamlDocumentRead } from "../shared/yaml-document.ts";
import { LAYER_RULES } from "./contract.ts";

export type LayerDocument = YamlDocument;

export function readLayerDocument(path: string): YamlDocumentRead {
  return readYamlDocument(path, LAYER_RULES.document);
}
