import type { AggregateId } from "./aggregate-id";
import type { Event } from "./event";

type EventSerializer<AID extends AggregateId, E extends Event<AID>> = {
  serialize(event: E): Uint8Array;
  deserialize(bytes: Uint8Array, converter: (json: unknown) => E): E;
};

export type { EventSerializer };
