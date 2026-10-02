/**
 * Whether the domain model the code checks decide against is available for the project. Shared by
 * every language's code checks, so an absent or unreadable model means the same to all of them.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { finding, type ProjectContext, relPath } from "../project/context.ts";
import { MODEL_FILE } from "../schema/artifacts.ts";
import { loadDomainModel } from "../schema/loader.ts";
import type { FindingInput } from "../shared/findings.ts";
import type { ModelAvailability } from "./types.ts";

/** The model of the project, and the finding a model file that does not load raises. */
export function readModelAvailability(run: ProjectContext): { model: ModelAvailability; findings: FindingInput[] } {
  const modelPath = join(run.modelDir, MODEL_FILE);
  if (!existsSync(modelPath)) {
    return {
      model: {
        status: "absent",
        note: `${relPath(run, modelPath)} is absent; model-dependent checks (b, h, c-model, n-model) skipped`,
      },
      findings: [],
    };
  }
  const loaded = loadDomainModel(modelPath);
  if (!loaded.ok)
    return {
      model: { status: "invalid" },
      findings: [finding("model.invalid", relPath(run, modelPath), `${MODEL_FILE} did not load`)],
    };
  return { model: { status: "available", index: loaded.index }, findings: [] };
}
