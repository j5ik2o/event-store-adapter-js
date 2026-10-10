import { EventStoreError } from "./event-store-error";
import { validateSeqNr } from "./internal/seq-nr-validation";
import { Result } from "./result";
import type { SnapshotEnvelopeInput } from "./snapshot-envelope-input";

export type SnapshotEnvelope<S = unknown> = Readonly<{
  seqNr: number;
  manifest: string;
  aggregate: S;
}>;

export namespace SnapshotEnvelope {
  export function create<S>(
    input: SnapshotEnvelopeInput<S>,
  ): Result<SnapshotEnvelope<S>, EventStoreError> {
    // 型のない呼び出しで入力そのものが欠けることがあるため、実行時に検査する。
    const raw = input as Partial<SnapshotEnvelopeInput<S>> | null | undefined;
    if (raw === undefined || raw === null) {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "T-10",
          detail: "input is missing",
        }),
      );
    }
    const { seqNr: inputSeqNr, manifest, aggregate } = raw;
    const missing = [
      inputSeqNr == null ? "seqNr" : undefined,
      aggregate === undefined ? "aggregate" : undefined,
    ].filter((name): name is string => name !== undefined);
    if (missing.length > 0) {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "T-10",
          detail: `missing required element: ${missing.join(", ")}`,
          ...(typeof inputSeqNr === "number" ? { seqNr: inputSeqNr } : {}),
        }),
      );
    }
    const seqNr = validateSeqNr(inputSeqNr);
    if (seqNr.type === "err") {
      return seqNr;
    }
    if (manifest !== undefined && typeof manifest !== "string") {
      return Result.err(
        EventStoreError.contractViolation({
          rule: "T-10",
          detail: "manifest must be a string",
          seqNr: seqNr.value,
        }),
      );
    }
    return Result.ok(
      Object.freeze({
        seqNr: seqNr.value,
        manifest: manifest ?? "",
        aggregate: aggregate as S,
      }),
    );
  }
}

// Freeze the namespace so the functions cannot be replaced at runtime.
Object.freeze(SnapshotEnvelope);
