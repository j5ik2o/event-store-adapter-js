import type { ContractRule } from "./contract-rule";

export type EventStoreError =
  | {
      type: "optimistic-lock-conflict";
      message: string;
      aggregateId: string;
      seqNr: number;
      headSeqNr?: number;
      cause?: unknown;
    }
  | {
      type: "contract-violation";
      rule: ContractRule;
      message: string;
      seqNr?: number;
      snapshotSeqNr?: number;
      cause?: unknown;
    }
  | {
      type: "serialization-error";
      operation: "serialize" | "deserialize";
      message: string;
      cause?: unknown;
    }
  | {
      type: "configuration-error";
      fieldName: string;
      message: string;
      cause?: unknown;
    }
  | { type: "storage-error"; message: string; cause?: unknown };

export namespace EventStoreError {
  export function optimisticLockConflict(input: {
    aggregateId: string;
    seqNr: number;
    headSeqNr?: number;
    cause?: unknown;
  }): Extract<EventStoreError, { type: "optimistic-lock-conflict" }> {
    const head =
      input.headSeqNr !== undefined ? `; headSeqNr=${input.headSeqNr}` : "";
    return Object.freeze({
      type: "optimistic-lock-conflict",
      message: `optimistic lock conflict; aggregateId=${input.aggregateId}; seqNr=${input.seqNr}${head}`,
      aggregateId: input.aggregateId,
      seqNr: input.seqNr,
      ...(input.headSeqNr !== undefined ? { headSeqNr: input.headSeqNr } : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });
  }

  export function contractViolation(input: {
    rule: ContractRule;
    seqNr?: number;
    snapshotSeqNr?: number;
    detail?: string;
    cause?: unknown;
  }): Extract<EventStoreError, { type: "contract-violation" }> {
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

  export function serialization(
    operation: "serialize" | "deserialize",
    message: string,
    cause?: unknown,
  ): Extract<EventStoreError, { type: "serialization-error" }> {
    return Object.freeze({
      type: "serialization-error",
      operation,
      message,
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  export function configuration(
    fieldName: string,
    message: string,
    cause?: unknown,
  ): Extract<EventStoreError, { type: "configuration-error" }> {
    return Object.freeze({
      type: "configuration-error",
      fieldName,
      message,
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  export function storage(
    message: string,
    cause?: unknown,
  ): Extract<EventStoreError, { type: "storage-error" }> {
    return Object.freeze({
      type: "storage-error",
      message,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// Freeze the namespace so the constructors cannot be replaced at runtime.
Object.freeze(EventStoreError);
