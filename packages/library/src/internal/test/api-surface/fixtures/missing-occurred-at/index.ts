// イベント封筒から occurredAt を消した定義。ほかは公開 API と同じ形
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

export type EventEnvelope<P = unknown> = Readonly<{
  aggregateId: AggregateId;
  seqNr: number;
  manifest: string;
  payload: P;
}>;

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
