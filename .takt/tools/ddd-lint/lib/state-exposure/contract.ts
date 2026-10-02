export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type SchemaVersion = "state-exposure/1";
export type Language = "rust" | "typescript";
export type Digest = string;
export type RequestIdentity = string;

export interface Target {
  readonly file: string;
  readonly declarationPath: readonly string[];
  readonly representation: "rust-struct" | "ts-class" | "ts-companion";
}
export interface SourceInput {
  readonly path: string;
  readonly content: string;
}
export interface ToolVersion {
  readonly name: string;
  readonly version: string;
}
export interface InspectionInput {
  readonly language: Language;
  readonly target: Target;
  readonly sources: readonly SourceInput[];
  readonly settings: { readonly [key: string]: JsonValue };
  readonly toolchain: readonly ToolVersion[];
}
export interface SourceSnapshot {
  readonly path: string;
  readonly sha256: Digest;
  readonly byteLength: number;
  readonly lineStarts: readonly number[];
}
export interface InspectionRequest {
  readonly schemaVersion: SchemaVersion;
  readonly ruleId: "state-exposure";
  readonly requestIdentity: RequestIdentity;
  readonly language: Language;
  readonly target: Target;
  readonly sources: readonly SourceSnapshot[];
  readonly settings: { readonly [key: string]: JsonValue };
  readonly toolchain: readonly ToolVersion[];
}
export interface Location {
  readonly file: string;
  readonly line: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}
export type ReasonCode =
  | "invalid-request"
  | "unknown-version"
  | "invalid-response"
  | "identity-mismatch"
  | "target-missing"
  | "target-ambiguous"
  | "syntax-error"
  | "unsupported-syntax"
  | "incomplete-evidence"
  | "tool-unavailable"
  | "execution-failed"
  | "timeout"
  | "output-limit"
  | "resource-limit";
export interface Issue {
  readonly code: ReasonCode;
  readonly message: string;
  readonly subject: string;
  readonly location: Location | null;
}
export type Fact<T> =
  | { readonly status: "resolved"; readonly value: T; readonly evidence: readonly Location[] }
  | { readonly status: "absent"; readonly evidence: readonly Location[] }
  | { readonly status: "unresolved"; readonly reasons: readonly Issue[] };
export interface MemberEvidence {
  readonly memberId: string;
  readonly stateExposure: Fact<boolean>;
}
export type StateEvidence =
  | {
      readonly targetStatus: "resolved";
      readonly targetEvidence: readonly Location[];
      readonly members: {
        readonly completeness: "complete" | "partial";
        readonly items: readonly MemberEvidence[];
        readonly reasons: readonly Issue[];
      };
    }
  | { readonly targetStatus: "unresolved"; readonly reasons: readonly Issue[] };
export interface EvidenceResponse {
  readonly schemaVersion: SchemaVersion;
  readonly requestIdentity: RequestIdentity;
  readonly evidence: StateEvidence;
}
export type ExtractionExecution =
  // responseキーは必須。応答なしはnullで表し、キー欠落とは区別する。
  | { readonly status: "completed"; readonly response: unknown }
  | { readonly status: "unavailable"; readonly reasons: readonly Issue[] }
  | { readonly status: "failed"; readonly reasons: readonly Issue[] };
export interface Finding {
  readonly code: "state-exposed";
  readonly memberId: string;
  readonly evidence: readonly Location[];
}
export interface InspectionResult {
  readonly schemaVersion: SchemaVersion;
  readonly requestIdentity: RequestIdentity;
  readonly target: Target;
  readonly executionState: "completed" | "unavailable" | "failed";
  readonly ruleResult: "pass" | "violation" | "unresolved";
  readonly checkedEvidence: StateEvidence | null;
  readonly findings: readonly Finding[];
  readonly unresolvedReasons: readonly Issue[];
}
export type RequestPreparation =
  | { readonly kind: "prepared"; readonly request: InspectionRequest }
  | { readonly kind: "input-rejected"; readonly issues: readonly Issue[] };
export type InspectionOutcome =
  | { readonly kind: "evaluated"; readonly result: InspectionResult }
  | { readonly kind: "input-rejected"; readonly issues: readonly Issue[] };

export const SCHEMA_VERSION: SchemaVersion = "state-exposure/1";
export const RULE_ID = "state-exposure" as const;
export const REASON_CODES: readonly ReasonCode[] = Object.freeze([
  "invalid-request",
  "unknown-version",
  "invalid-response",
  "identity-mismatch",
  "target-missing",
  "target-ambiguous",
  "syntax-error",
  "unsupported-syntax",
  "incomplete-evidence",
  "tool-unavailable",
  "execution-failed",
  "timeout",
  "output-limit",
  "resource-limit",
]);
