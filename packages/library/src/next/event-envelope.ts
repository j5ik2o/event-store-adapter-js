import { Result } from "../result";
import type { AggregateId } from "./aggregate-id";
import type { EventEnvelopeInput } from "./event-envelope-input";
import { EventStoreError } from "./event-store-error";
import { validateOccurredAt } from "./internal/occurred-at-validation";
import { validateSeqNr } from "./internal/seq-nr-validation";

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
    const missing = [
      raw.aggregateId == null ? "aggregateId" : undefined,
      raw.seqNr == null ? "seqNr" : undefined,
      raw.occurredAt == null ? "occurredAt" : undefined,
      raw.payload === undefined ? "payload" : undefined,
    ].filter((name): name is string => name !== undefined);
    if (missing.length > 0) {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "T-2",
          detail: `missing required element: ${missing.join(", ")}`,
          ...(typeof raw.seqNr === "number" ? { seqNr: raw.seqNr } : {}),
        }),
      );
    }
    const seqNr = validateSeqNr(raw.seqNr);
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
    const occurredAt = validateOccurredAt(raw.occurredAt, seqNr.value);
    if (occurredAt.type === "err") {
      return occurredAt;
    }
    return Result.ok(
      Object.freeze({
        aggregateId: raw.aggregateId as AggregateId,
        seqNr: seqNr.value,
        occurredAt: occurredAt.value,
        manifest: raw.manifest ?? "",
        payload: raw.payload as P,
      }),
    );
  }
}

// Freeze the namespace so the functions cannot be replaced at runtime.
Object.freeze(EventEnvelope);
