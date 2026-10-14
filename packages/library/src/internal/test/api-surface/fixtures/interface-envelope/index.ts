// イベント封筒を type の別名ではなく interface で書いた定義。形は公開 API と同じ（誤って報告しないことを見る）
export type AggregateId = Readonly<{ typeName: string; value: string }>;

export type Result<T, E> = { type: "ok"; value: T } | { type: "err"; error: E };

export type EventStoreError =
  | { type: "optimistic-lock-conflict"; message: string }
  | { type: "contract-violation"; message: string }
  | { type: "serialization-error"; message: string }
  | { type: "configuration-error"; message: string }
  | { type: "storage-error"; message: string };

export type EventEnvelopeInput<P = unknown> = Readonly<{
  aggregateId: AggregateId;
  seqNr: number;
  occurredAt: Date;
  manifest?: string;
  payload: P;
}>;

export interface EventEnvelope<P = unknown> {
  readonly aggregateId: AggregateId;
  readonly seqNr: number;
  readonly occurredAt: Date;
  readonly manifest: string;
  readonly payload: P;
}

export declare namespace EventEnvelope {
  function create<P>(
    input: EventEnvelopeInput<P>,
  ): Result<EventEnvelope<P>, EventStoreError>;
}

export type SnapshotEnvelopeInput<S = unknown> = Readonly<{
  seqNr: number;
  manifest?: string;
  aggregate: S;
}>;

export type SnapshotEnvelope<S = unknown> = Readonly<{
  seqNr: number;
  manifest: string;
  aggregate: S;
}>;

export declare namespace SnapshotEnvelope {
  function create<S>(
    input: SnapshotEnvelopeInput<S>,
  ): Result<SnapshotEnvelope<S>, EventStoreError>;
}

export type LatestSnapshot<S = unknown> = Readonly<{
  snapshot?: SnapshotEnvelope<S>;
  headSeqNr: number;
}>;

export type EventStore<PE = unknown, PS = unknown> = {
  persistEvent(
    event: EventEnvelope<PE>,
  ): Promise<Result<void, EventStoreError>>;
  persistEventAndSnapshot(
    event: EventEnvelope<PE>,
    snapshot: SnapshotEnvelope<PS>,
  ): Promise<Result<void, EventStoreError>>;
  getLatestSnapshotById(
    aggregateId: AggregateId,
  ): Promise<Result<LatestSnapshot<PS> | undefined, EventStoreError>>;
  getEventsByIdSinceSeqNr(
    aggregateId: AggregateId,
    seqNr: number,
  ): Promise<Result<EventEnvelope<PE>[], EventStoreError>>;
};
