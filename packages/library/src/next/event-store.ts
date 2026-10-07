import type { Result } from "../result";
import type { AggregateId } from "./aggregate-id";
import type { EventEnvelope } from "./event-envelope";
import type { EventStoreError } from "./event-store-error";
import type { LatestSnapshot } from "./latest-snapshot";
import type { SnapshotEnvelope } from "./snapshot-envelope";

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
