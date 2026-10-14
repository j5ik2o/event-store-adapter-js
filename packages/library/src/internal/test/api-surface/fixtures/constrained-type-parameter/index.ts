// イベント封筒の型の引数を P extends object に狭めた定義。ほかは公開 API と同じ形
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

export type EventEnvelope<P extends object = object> = Readonly<{
  aggregateId: AggregateId;
  seqNr: number;
  occurredAt: Date;
  manifest: string;
  payload: P;
}>;

export declare namespace EventEnvelope {
  function create<P extends object>(
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
    // @ts-expect-error 狭めた型の引数 P に、制約のない PE は渡せない（ずれの副作用）
    event: EventEnvelope<PE>,
  ): Promise<Result<void, EventStoreError>>;
  persistEventAndSnapshot(
    // @ts-expect-error 狭めた型の引数 P に、制約のない PE は渡せない（ずれの副作用）
    event: EventEnvelope<PE>,
    snapshot: SnapshotEnvelope<PS>,
  ): Promise<Result<void, EventStoreError>>;
  getLatestSnapshotById(
    aggregateId: AggregateId,
  ): Promise<Result<LatestSnapshot<PS> | undefined, EventStoreError>>;
  getEventsByIdSinceSeqNr(
    aggregateId: AggregateId,
    seqNr: number,
  ): // @ts-expect-error 同上
  Promise<Result<EventEnvelope<PE>[], EventStoreError>>;
};
