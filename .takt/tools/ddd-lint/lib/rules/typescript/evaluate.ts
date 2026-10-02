/**
 * The evaluations of the TypeScript gates, each with the rules and rule ids of the Rust gate of the
 * same layer:
 *
 * - domain: the layer diagnostics, rules (a), (b), (c), (d) and port placement over each checked
 *   domain source, then the dependency direction (g), and domain packaging over each domain package
 *   the checked sources touch;
 * - use-case: rules (h), (i), (d) and use-case naming over each checked use-case source, then the
 *   dependency direction and external I/O (g);
 * - interface-adapter: rules (l), (m) and (n) over each checked interface-adapter or rmu source and
 *   each checked query-side source, then the cross-side rule (k) and the dependency direction (g).
 *
 * A construct any of the rules could not decide stops the whole gate once they have all run, as a
 * source the facts could not describe stops it before they run: a verdict is only given over what
 * was decided.
 */

import type { ProjectContext } from "../../project/context.ts";
import { type CheckApi, type CheckEvaluation, ToolUnavailableError } from "../../project/context.ts";
import type { FindingInput } from "../../shared/findings.ts";
import { dedupe } from "../evaluate.ts";
import { assembleTypeScriptInspection } from "./context.ts";
import { buildEdges, ruleG, ruleK } from "./edges.ts";
import {
  ruleCollection,
  ruleImmutable,
  ruleOperation,
  rulePortPlacement,
  ruleC,
  ruleD,
  ruleDomainPackaging,
} from "./evaluators.ts";
import { factsOf } from "./file-facts.ts";
import { ruleL, ruleM, ruleN } from "./interface-adapter.ts";
import { ruleA } from "./state-hiding.ts";
import type { TsGate, TsInspection, TsTarget } from "./types.ts";
import { ruleH, ruleI, ruleUseCaseName } from "./use-case.ts";

const DOMAIN: TsGate = {
  label: "domain",
  target_layers: ["domain"],
  includes_query_side: false,
  described_layers: ["domain"],
  reports_layer_diagnostics: true,
};

// A use case, a port or a repository port the rules resolve may be declared in any use-case source.
const USE_CASE: TsGate = {
  label: "use-case",
  target_layers: ["use-case"],
  includes_query_side: false,
  described_layers: ["domain", "use-case"],
  reports_layer_diagnostics: false,
};

const INTERFACE_ADAPTER: TsGate = {
  label: "interface-adapter",
  target_layers: ["interface-adapter", "rmu"],
  includes_query_side: true,
  described_layers: ["domain"],
  reports_layer_diagnostics: false,
};

/** The rules of one gate over an assembled inspection: those of the whole run, then those of each checked source. */
interface GateRules {
  readonly whole: (inspection: TsInspection, api: CheckApi) => FindingInput[];
  readonly perFile: (inspection: TsInspection, target: TsTarget) => FindingInput[];
}

function evaluateGate(run: ProjectContext, api: CheckApi, gate: TsGate, rules: GateRules): CheckEvaluation {
  const assembled = assembleTypeScriptInspection(run, gate);
  if (assembled.kind === "empty") return { findings: [], note: assembled.note };
  if (assembled.kind === "findings-only")
    return { findings: dedupe(assembled.findings), ...(assembled.note ? { note: assembled.note } : {}) };
  const inspection = assembled.inspection;
  const findings: FindingInput[] = [
    ...assembled.findings,
    ...(gate.reports_layer_diagnostics ? inspection.layerDiagnostics : []),
  ];
  for (const target of inspection.targets) {
    api.checkBudget();
    findings.push(...rules.perFile(inspection, target));
  }
  findings.push(...rules.whole(inspection, api));
  if (inspection.undecided.items.length > 0)
    throw new ToolUnavailableError(
      `the TypeScript ${gate.label} rules cannot decide ${inspection.undecided.items.join("; ")}`,
    );
  const noteParts = [...[...inspection.notes].sort(), ...(assembled.note ? [assembled.note] : [])];
  return { findings: dedupe(findings), ...(noteParts.length > 0 ? { note: noteParts.join("; ") } : {}) };
}

export function evaluateTypeScriptDomain(run: ProjectContext, api: CheckApi): CheckEvaluation {
  return evaluateGate(run, api, DOMAIN, {
    perFile: (inspection, target) => [
      ...ruleA(target.file, factsOf(inspection, target.file), inspection.undecided),
      ...ruleImmutable(inspection, target),
      ...ruleOperation(inspection, target),
      ...ruleCollection(inspection, target),
      ...rulePortPlacement(inspection, target),
      ...ruleC(inspection, target),
      ...ruleD(inspection, target),
    ],
    whole: (inspection, api) => {
      const findings = ruleG(buildEdges(inspection));
      for (const pkg of new Map(inspection.targets.map((target) => [target.pkg.root, target.pkg])).values()) {
        api.checkBudget();
        findings.push(...ruleDomainPackaging(inspection, pkg));
      }
      return findings;
    },
  });
}

export function evaluateTypeScriptUseCase(run: ProjectContext, api: CheckApi): CheckEvaluation {
  return evaluateGate(run, api, USE_CASE, {
    perFile: (inspection, target) => [
      ...ruleH(inspection, target),
      ...ruleI(inspection, target),
      ...ruleD(inspection, target),
      ...ruleUseCaseName(inspection, target),
    ],
    whole: (inspection) => ruleG(buildEdges(inspection)),
  });
}

export function evaluateTypeScriptInterfaceAdapter(run: ProjectContext, api: CheckApi): CheckEvaluation {
  return evaluateGate(run, api, INTERFACE_ADAPTER, {
    perFile: (inspection, target) => [
      ...ruleL(inspection, target),
      ...ruleM(inspection, target),
      ...ruleN(inspection, target),
    ],
    whole: (inspection) => {
      const edges = buildEdges(inspection);
      return [...ruleK(edges), ...ruleG(edges)];
    },
  });
}
