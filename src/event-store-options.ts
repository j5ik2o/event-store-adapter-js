import {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  KeyResolver,
  SnapshotSerializer,
} from "./types";
import * as moment from "moment";

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
}

export { EventStoreOptions };
