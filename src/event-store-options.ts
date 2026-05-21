import type moment from "moment";
import type {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  Logger,
  SnapshotSerializer,
} from "./types";

interface EventStoreOptions<
  This extends EventStoreOptions<This, AID, A, E>,
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> {
  /**
   * Enables snapshot retention after successful event persistence.
   *
   * Retention failures are propagated to the caller even though the event and
   * latest snapshot may already be persisted.
   *
   * Non-finite counts fail retention. Counts are floored to the nearest
   * non-negative integer, so negative counts and fractional values in the
   * range [0, 1) become zero and all redundant snapshots become retention
   * targets.
   */
  withKeepSnapshotCount(keepSnapshotCount: number): This;

  withDeleteTtl(deleteTtl: moment.Duration): This;

  withKeyResolver(keyResolver: KeyResolver<AID>): This;

  withEventSerializer(eventSerializer: EventSerializer<AID, E>): This;

  withSnapshotSerializer(snapshotSerializer: SnapshotSerializer<AID, A>): This;

  withLogger(logger: Logger): This;
}

export type { EventStoreOptions };
