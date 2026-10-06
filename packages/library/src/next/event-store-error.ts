import type { ContractRule } from "./contract-rule";

export type EventStoreError = {
  type: "contract-violation";
  rule: ContractRule;
  message: string;
  seqNr?: number;
  snapshotSeqNr?: number;
  cause?: unknown;
};

export namespace EventStoreError {
  export function contractViolation(input: {
    rule: ContractRule;
    seqNr?: number;
    snapshotSeqNr?: number;
    detail?: string;
    cause?: unknown;
  }): EventStoreError {
    const parts = [`contract violation (${input.rule})`];
    if (input.detail !== undefined) {
      parts.push(`: ${input.detail}`);
    }
    if (input.seqNr !== undefined) {
      parts.push(`; seqNr=${input.seqNr}`);
    }
    if (input.snapshotSeqNr !== undefined) {
      parts.push(`; snapshotSeqNr=${input.snapshotSeqNr}`);
    }
    return Object.freeze({
      type: "contract-violation",
      rule: input.rule,
      message: parts.join(""),
      ...(input.seqNr !== undefined ? { seqNr: input.seqNr } : {}),
      ...(input.snapshotSeqNr !== undefined
        ? { snapshotSeqNr: input.snapshotSeqNr }
        : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });
  }
}

// Freeze the namespace so the constructors cannot be replaced at runtime.
Object.freeze(EventStoreError);
