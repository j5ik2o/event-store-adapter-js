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
  withKeepSnapshotCount(keepSnapshotCount: number): This;

  withDeleteTtl(deleteTtl: moment.Duration): This;

  withKeyResolver(keyResolver: KeyResolver<AID>): This;

  withEventSerializer(eventSerializer: EventSerializer<AID, E>): This;

  withSnapshotSerializer(snapshotSerializer: SnapshotSerializer<AID, A>): This;

  withLogger(logger: Logger): This;
}

export type { EventStoreOptions };
