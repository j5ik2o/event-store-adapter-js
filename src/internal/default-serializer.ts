import type { Aggregate, AggregateId, Event } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class JsonEventSerializer {
  deserialize<E>(bytes: Uint8Array, converter: (json: unknown) => E): E {
    const jsonString = decoder.decode(bytes);
    const json = JSON.parse(jsonString);
    return converter(json);
  }

  serialize<AID extends AggregateId, E extends Event<AID>>(
    event: E,
  ): Uint8Array {
    const jsonString = JSON.stringify({
      type: event.typeName,
      data: event,
    });
    return encoder.encode(jsonString);
  }
}

class JsonSnapshotSerializer {
  deserialize<A>(bytes: Uint8Array, converter: (json: unknown) => A): A {
    const jsonString = decoder.decode(bytes);
    const obj = JSON.parse(jsonString);
    return converter(obj);
  }

  serialize<AID extends AggregateId, A extends Aggregate<A, AID>>(
    aggregate: A,
  ): Uint8Array {
    const jsonString = JSON.stringify({
      type: aggregate.typeName,
      data: aggregate,
    });
    return encoder.encode(jsonString);
  }
}

export { JsonEventSerializer, JsonSnapshotSerializer };
