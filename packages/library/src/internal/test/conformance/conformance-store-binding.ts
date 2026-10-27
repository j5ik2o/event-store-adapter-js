import type { ConformanceAggregateIdInput } from "./conformance-aggregate-id-input";
import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import type { ConformanceEventInput } from "./conformance-event-input";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceSnapshotInput } from "./conformance-snapshot-input";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

export interface ConformanceStoreBinding<E, S> {
  readonly backend: ConformanceBackend;
  createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<E, S>>;
  buildAggregateId(
    input: ConformanceAggregateIdInput,
  ): ConformanceOutcome<string>;
  buildEvent(d: ConformanceEventInput): ConformanceOutcome<E>;
  buildSnapshot(d: ConformanceSnapshotInput): ConformanceOutcome<S>;
  /** ハッシュを使う保存先だけが持つ。値の表の fnv1a64 を実行する。 */
  fnv1a64?(utf8: string): bigint;
  /** 封筒の形式を持つ保存先（Bigtable）だけが持つ。値の表の封筒の操作を実行する。 */
  encodeBigtableEventEnvelope?(input: {
    aid: string;
    seqNr: number;
    occurredAtNs: bigint;
    manifest: string;
    payloadHex: string;
  }): ConformanceOutcome<string>;
  encodeBigtableSnapshotEnvelope?(input: {
    seqNr: number;
    manifest: string;
    payloadHex: string;
  }): ConformanceOutcome<string>;
  decodeBigtableEnvelope?(input: {
    kind: "event" | "snapshot";
    bytesHex: string;
  }): ConformanceOutcome<unknown>;
  validateSeqNrValue(
    seqNr: bigint,
    context?: "event" | "value",
  ): ConformanceOutcome<bigint>;
}
