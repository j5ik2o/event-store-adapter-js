import { ContractError } from "./canonical.ts";
import type {
  Finding,
  InspectionOutcome,
  InspectionRequest,
  InspectionResult,
  Issue,
  StateEvidence,
} from "./contract.ts";
import { SCHEMA_VERSION } from "./contract.ts";
import { validateExecution, validateResponse } from "./evidence.ts";
import { compareIssues } from "./locations.ts";
import { validateRequest } from "./request.ts";

function result(
  request: InspectionRequest,
  executionState: InspectionResult["executionState"],
  checkedEvidence: StateEvidence | null,
  findings: readonly Finding[],
  reasons: readonly Issue[],
): InspectionOutcome {
  return {
    kind: "evaluated",
    result: {
      schemaVersion: SCHEMA_VERSION,
      requestIdentity: request.requestIdentity,
      target: request.target,
      executionState,
      ruleResult: reasons.length ? "unresolved" : findings.length ? "violation" : "pass",
      checkedEvidence,
      findings,
      unresolvedReasons: [...reasons].sort(compareIssues),
    },
  };
}

/** Only validated evidence reaches the rule; syntax and language never enter this decision. */
function judge(request: InspectionRequest, evidence: StateEvidence): InspectionOutcome {
  if (evidence.targetStatus === "unresolved") return result(request, "completed", evidence, [], evidence.reasons);
  const findings: Finding[] = [];
  const reasons: Issue[] = [...evidence.members.reasons];
  for (const member of evidence.members.items) {
    const fact = member.stateExposure;
    if (fact.status === "unresolved") reasons.push(...fact.reasons);
    else if (fact.status === "resolved" && fact.value) {
      findings.push({ code: "state-exposed", memberId: member.memberId, evidence: fact.evidence });
    }
  }
  return result(request, "completed", evidence, findings, reasons);
}

export function inspectStateExposure(request: unknown, execution: unknown): InspectionOutcome {
  try {
    const validatedRequest = validateRequest(request);
    const validatedExecution = validateExecution(execution, validatedRequest);
    if (validatedExecution.status !== "completed") {
      return result(validatedRequest, validatedExecution.status, null, [], validatedExecution.reasons);
    }
    const response = validateResponse(validatedExecution.response, validatedRequest);
    if (!response.valid) return result(validatedRequest, "completed", null, [], [response.issue]);
    return judge(validatedRequest, response.evidence);
  } catch (error) {
    if (error instanceof ContractError) return { kind: "input-rejected", issues: [error.issue] };
    throw error;
  }
}
