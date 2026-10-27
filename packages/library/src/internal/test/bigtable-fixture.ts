import type { AggregateId } from "../../aggregate-id";
import type { EventEnvelope } from "../../event-envelope";
import type { EventStoreError } from "../../event-store-error";
import type { Result } from "../../result";
import type { SnapshotEnvelope } from "../../snapshot-envelope";

export const id = (value: string): AggregateId => ({
  typeName: "Order",
  value,
});
const MILLIS = Date.parse("2026-10-09T00:00:00.123Z");
export const eventOf = (value: string, seqNr: number): EventEnvelope => ({
  aggregateId: id(value),
  seqNr,
  occurredAt: new Date(MILLIS),
  manifest: "event/v1",
  payload: { seqNr },
});
export const snapshotOf = (seqNr: number): SnapshotEnvelope => ({
  seqNr,
  manifest: "snapshot/v1",
  aggregate: { seqNr },
});

export function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message);
  return result.value;
}

/** Rust 版と同じ列の名前と値の形。 */
export const FAMILY = {
  event: "event",
  history: "history",
  head: "head",
  snapshot: "snapshot",
  config: "config",
} as const;

/** head:seq_nr は 20 桁の ASCII 数字。 */
export const headSeqNrBytes = (seqNr: number): Buffer =>
  Buffer.from(String(seqNr).padStart(20, "0"));
