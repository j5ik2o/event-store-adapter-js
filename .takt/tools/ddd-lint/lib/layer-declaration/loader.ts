/**
 * loadLayerDeclaration — reads `docs/ddd/layer-structure.yaml`.
 *
 * The read stops at the first step that fails: the document, its shape, the domain model it names,
 * the declaration against that model, and only then whether the declaration says everything the
 * format requires.
 */

import type { ElementIndex } from "../schema/index-builder.ts";
import { loadDomainModel } from "../schema/loader.ts";
import type { DomainModel } from "../schema/model.ts";
import { resolveModelPath } from "../project/context.ts";
import type { FindingInput } from "../shared/findings.ts";
import { LAYER_RULES, type LayerDeclaration } from "./contract.ts";
import { type LayerDocument, readLayerDocument } from "./document.ts";
import { completeDeclaration, readLayerDraft } from "./reader.ts";
import { validateLayerDraft } from "./validation.ts";

export type LayerLoadResult =
  | {
      readonly ok: true;
      readonly declaration: LayerDeclaration;
      /** The canonical model the declaration names, which the structural inspection checks against. */
      readonly model: DomainModel;
      readonly index: ElementIndex;
    }
  | { readonly ok: false; readonly findings: readonly FindingInput[] };

export type ModelLoad =
  | { readonly ok: true; readonly model: DomainModel; readonly index: ElementIndex }
  | { readonly ok: false; readonly findings: readonly FindingInput[] };

/**
 * How the domain model a declaration names is obtained: the checks read it from disk.
 */
export type ReferencedModelResolver = (document: LayerDocument, modelRef: string) => ModelLoad;

/**
 * The canonical model `modelRef` names, read in the operation-owned format only, so one record never
 * holds a declaration of this format beside a model of the older one. Every refusal is reported
 * against the declaration document, which is where the reference is written.
 */
export function loadReferencedModel(document: LayerDocument, modelRef: string): ModelLoad {
  const loaded = loadDomainModel(resolveModelPath(document.modelDir, modelRef));
  if (loaded.ok) return loaded;
  return {
    ok: false,
    findings: loaded.findings.map((entry) => ({
      rule_id: LAYER_RULES.model,
      file: document.path,
      message: `model_ref ${modelRef} does not load as a domain model: ${entry.rule_id}: ${entry.message}`,
    })),
  };
}

/** The read of a document already opened. */
export function loadLayerDocument(document: LayerDocument, resolveModel: ReferencedModelResolver): LayerLoadResult {
  const read = readLayerDraft(document.root, document.path);
  if (read.kind === "rejected") return { ok: false, findings: read.findings };
  const model = resolveModel(document, read.draft.model_ref);
  if (!model.ok) return model;
  const defects = validateLayerDraft(read.draft, model.index, document.path);
  if (defects.length > 0) return { ok: false, findings: defects };
  const completion = completeDeclaration(read.draft);
  // A value the document does not state is a value it has to state.
  if (!completion.complete)
    return {
      ok: false,
      findings: completion.missing.map((missing) => ({
        rule_id: LAYER_RULES.structure,
        file: document.path,
        message: `${missing} is not stated`,
      })),
    };
  return { ok: true, declaration: completion.declaration, model: model.model, index: model.index };
}

export function loadLayerDeclaration(path: string): LayerLoadResult {
  const read = readLayerDocument(path);
  if (read.kind === "rejected") return { ok: false, findings: read.findings };
  return loadLayerDocument(read.document, loadReferencedModel);
}
