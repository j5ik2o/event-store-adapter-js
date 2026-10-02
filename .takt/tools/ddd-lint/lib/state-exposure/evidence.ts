import {
  array,
  ContractError,
  jsonCopy,
  nonempty,
  record,
  requireValue,
  scalarCompare,
  withoutFields,
} from "./canonical.ts";
import type { Fact, InspectionRequest, Issue, MemberEvidence, StateEvidence } from "./contract.ts";
import { SCHEMA_VERSION } from "./contract.ts";
import { evidenceLocations, issues } from "./locations.ts";
import { isDigest } from "./request.ts";

type ValidatedExecution =
  | { readonly status: "completed"; readonly response: unknown }
  | { readonly status: "failed" | "unavailable"; readonly reasons: readonly Issue[] };

export function validateExecution(value: unknown, request: InspectionRequest): ValidatedExecution {
  const item = record(jsonCopy(value, "execution"), "execution");
  if (item.status === "completed") {
    requireValue(Object.hasOwn(item, "response"), "execution.response", "Completed execution requires a response key.");
    withoutFields(item, ["reasons"], "execution");
    return { status: "completed", response: item.response };
  }
  requireValue(
    item.status === "failed" || item.status === "unavailable",
    "execution.status",
    "Unknown execution status.",
  );
  withoutFields(item, ["response"], "execution");
  return { status: item.status, reasons: issues(item.reasons, request, "execution.reasons") };
}

function fact(value: unknown, request: InspectionRequest, subject: string): Fact<boolean> {
  const item = record(value, subject);
  if (item.status === "unresolved") {
    withoutFields(item, ["value", "evidence"], subject);
    return { status: "unresolved", reasons: issues(item.reasons, request, `${subject}.reasons`) };
  }
  requireValue(item.status === "resolved" || item.status === "absent", `${subject}.status`, "Unknown fact status.");
  withoutFields(item, item.status === "absent" ? ["value", "reasons"] : ["reasons"], subject);
  const evidence = evidenceLocations(item.evidence, request, `${subject}.evidence`);
  if (item.status === "absent") return { status: "absent", evidence };
  requireValue(typeof item.value === "boolean", `${subject}.value`, "State exposure must be boolean.");
  return { status: "resolved", value: item.value, evidence };
}

function members(value: unknown, request: InspectionRequest, subject: string): MemberEvidence[] {
  const found = new Set<string>();
  return array(value, subject)
    .map((value, i) => {
      const field = `${subject}.${i}`;
      const item = record(value, field);
      const memberId = nonempty(item.memberId, `${field}.memberId`);
      requireValue(!found.has(memberId), `${field}.memberId`, "Duplicate member identifier.");
      found.add(memberId);
      return { memberId, stateExposure: fact(item.stateExposure, request, `${field}.stateExposure`) };
    })
    .sort((a, b) => scalarCompare(a.memberId, b.memberId));
}

function stateEvidence(value: unknown, request: InspectionRequest): StateEvidence {
  const item = record(value, "response.evidence");
  if (item.targetStatus === "unresolved") {
    withoutFields(item, ["targetEvidence", "members"], "response.evidence");
    return { targetStatus: "unresolved", reasons: issues(item.reasons, request, "response.evidence.reasons") };
  }
  requireValue(item.targetStatus === "resolved", "response.evidence.targetStatus", "Unknown target status.");
  withoutFields(item, ["reasons"], "response.evidence");
  const targetEvidence = evidenceLocations(item.targetEvidence, request, "response.evidence.targetEvidence");
  const list = record(item.members, "response.evidence.members");
  requireValue(
    list.completeness === "complete" || list.completeness === "partial",
    "response.evidence.members.completeness",
    "Unknown completeness.",
  );
  const reasons = issues(
    list.reasons,
    request,
    "response.evidence.members.reasons",
    list.completeness === "partial" ? 1 : 0,
  );
  requireValue(
    list.completeness !== "complete" || reasons.length === 0,
    "response.evidence.members.reasons",
    "Complete lists cannot have enumeration issues.",
  );
  return {
    targetStatus: "resolved",
    targetEvidence,
    members: {
      completeness: list.completeness,
      items: members(list.items, request, "response.evidence.members.items"),
      reasons,
    },
  };
}

export type ResponseValidation =
  | { readonly valid: true; readonly evidence: StateEvidence }
  | { readonly valid: false; readonly issue: Issue };

/** Called only after the execution boundary has copied and validated JSON. */
export function validateResponse(value: unknown, request: InspectionRequest): ResponseValidation {
  try {
    const item = record(value, "response");
    const version = nonempty(item.schemaVersion, "response.schemaVersion");
    requireValue(isDigest(item.requestIdentity), "response.requestIdentity", "Invalid response identity.");
    requireValue(Object.hasOwn(item, "evidence"), "response.evidence", "Response requires evidence.");
    if (version !== SCHEMA_VERSION)
      return {
        valid: false,
        issue: {
          code: "unknown-version",
          subject: "response.schemaVersion",
          message: "Unsupported response schema version.",
          location: null,
        },
      };
    if (item.requestIdentity !== request.requestIdentity)
      return {
        valid: false,
        issue: {
          code: "identity-mismatch",
          subject: "response.requestIdentity",
          message: "Response identity does not match the request.",
          location: null,
        },
      };
    return { valid: true, evidence: stateEvidence(item.evidence, request) };
  } catch (error) {
    if (error instanceof ContractError)
      return {
        valid: false,
        issue: {
          code: "invalid-response",
          subject: "response",
          message: `${error.issue.subject}: ${error.issue.message}`,
          location: null,
        },
      };
    throw error;
  }
}
