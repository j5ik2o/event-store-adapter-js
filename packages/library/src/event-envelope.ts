import type { AggregateId } from "./aggregate-id";
import type { EventEnvelopeInput } from "./event-envelope-input";
import { EventStoreError } from "./event-store-error";
import { validateOccurredAt } from "./internal/occurred-at-validation";
import { validateSeqNr } from "./internal/seq-nr-validation";
import { Result } from "./result";

export type EventEnvelope<P = unknown> = Readonly<{
  aggregateId: AggregateId;
  seqNr: number;
  occurredAt: Date;
  manifest: string;
  payload: P;
}>;

export namespace EventEnvelope {
  export function create<P>(
    input: EventEnvelopeInput<P>,
  ): Result<EventEnvelope<P>, EventStoreError> {
    // 型のない呼び出しで入力そのものが欠けることがあるため、実行時に検査する。
    const raw = input as Partial<EventEnvelopeInput<P>> | null | undefined;
    if (raw === undefined || raw === null) {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "T-2",
          detail: "input is missing",
        }),
      );
    }
    const {
      aggregateId,
      seqNr: inputSeqNr,
      occurredAt: inputOccurredAt,
      manifest,
      payload,
    } = raw;
    const missing = [
      aggregateId == null ? "aggregateId" : undefined,
      inputSeqNr == null ? "seqNr" : undefined,
      inputOccurredAt == null ? "occurredAt" : undefined,
      payload === undefined ? "payload" : undefined,
    ].filter((name): name is string => name !== undefined);
    if (missing.length > 0) {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "T-2",
          detail: `missing required element: ${missing.join(", ")}`,
          ...(typeof inputSeqNr === "number" ? { seqNr: inputSeqNr } : {}),
        }),
      );
    }
    const seqNr = validateSeqNr(inputSeqNr);
    if (seqNr.type === "err") {
      return seqNr;
    }
    if (seqNr.value === 0) {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "W-6",
          detail: "seqNr of an event must be 1 or greater",
          seqNr: 0,
        }),
      );
    }
    const occurredAt = validateOccurredAt(inputOccurredAt, seqNr.value);
    if (occurredAt.type === "err") {
      return occurredAt;
    }
    if (manifest !== undefined && typeof manifest !== "string") {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "T-2",
          detail: "manifest must be a string",
          seqNr: seqNr.value,
        }),
      );
    }
    return Result.ok(
      Object.freeze({
        aggregateId: aggregateId as AggregateId,
        seqNr: seqNr.value,
        occurredAt: occurredAt.value,
        manifest: manifest ?? "",
        payload: payload as P,
      }),
    );
  }
}

// Freeze the namespace so the functions cannot be replaced at runtime.
Object.freeze(EventEnvelope);
