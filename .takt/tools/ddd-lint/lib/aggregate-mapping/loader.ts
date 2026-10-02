/**
 * loadAggregateMapping — reads `docs/ddd/aggregate-mapping.yaml`.
 *
 * The read stops at the first step that fails: the document, its shape, the domain model it names,
 * and only then the mapping against that model.
 */

import type { ElementIndex } from "../schema/index-builder.ts";
import { loadDomainModel } from "../schema/loader.ts";
import type { DomainModel } from "../schema/model.ts";
import { resolveModelPath } from "../project/context.ts";
import type { FindingInput } from "../shared/findings.ts";
import { type ImplementationMapping, MAPPING_RULES } from "./contract.ts";
import { type MappingDocument, readMappingDocument } from "./document.ts";
import { readMappingDraft } from "./reader.ts";
import { validateMapping } from "./validation.ts";

export type MappingLoadResult =
  | {
      readonly ok: true;
      readonly mapping: ImplementationMapping;
      /** The canonical model the mapping names, so a caller never re-reads it to check the same thing. */
      readonly model: DomainModel;
      readonly index: ElementIndex;
    }
  | { readonly ok: false; readonly findings: readonly FindingInput[] };

export type ModelLoad =
  | { readonly ok: true; readonly model: DomainModel; readonly index: ElementIndex }
  | { readonly ok: false; readonly findings: readonly FindingInput[] };

/**
 * How the domain model a mapping names is obtained: the checks read it from disk.
 */
export type ReferencedModelResolver = (document: MappingDocument, modelRef: string) => ModelLoad;

/**
 * The canonical model `modelRef` names, read in the operation-owned format only: a factory rule
 * owns business errors there and nowhere else, and the mapping has to name them. Every refusal is
 * reported against the mapping document, which is where the reference is written.
 */
export function loadReferencedModel(document: MappingDocument, modelRef: string): ModelLoad {
  const modelPath = resolveModelPath(document.modelDir, modelRef);
  const loaded = loadDomainModel(modelPath);
  if (loaded.ok) return loaded;
  return {
    ok: false,
    findings: loaded.findings.map((entry) => ({
      rule_id: MAPPING_RULES.model,
      file: document.path,
      message: `model_ref ${modelRef} does not load as a domain model: ${entry.rule_id}: ${entry.message}`,
    })),
  };
}

/** The read of a document already opened. */
export function loadMappingDocument(
  document: MappingDocument,
  resolveModel: ReferencedModelResolver,
): MappingLoadResult {
  const read = readMappingDraft(document.root, document.path);
  if (read.kind === "rejected") return { ok: false, findings: read.findings };
  const model = resolveModel(document, read.draft.model_ref);
  if (!model.ok) return model;
  const validation = validateMapping(read.draft, model.model, model.index, {
    document: document.path,
    names: document.path,
  });
  if (!validation.complete) {
    const gaps = validation.missing.map((missing) => ({
      rule_id: MAPPING_RULES.coverage,
      file: document.path,
      message: `${missing} is required by the canonical model but not mapped`,
    }));
    return { ok: false, findings: [...validation.findings, ...gaps] };
  }
  if (validation.findings.length > 0) return { ok: false, findings: validation.findings };
  return { ok: true, mapping: validation.mapping, model: model.model, index: model.index };
}

export function loadAggregateMapping(path: string): MappingLoadResult {
  const read = readMappingDocument(path);
  if (read.kind === "rejected") return { ok: false, findings: read.findings };
  return loadMappingDocument(read.document, loadReferencedModel);
}
