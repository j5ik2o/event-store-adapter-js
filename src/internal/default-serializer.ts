import type { Aggregate, AggregateId, Event } from "../types";

class JsonEventSerializer {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  deserialize<E>(bytes: Uint8Array, converter: (json: unknown) => E): E {
    const jsonString = this.decoder.decode(bytes);
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
    return this.encoder.encode(jsonString);
  }
}

class JsonSnapshotSerializer {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  deserialize<A>(bytes: Uint8Array, converter: (json: unknown) => A): A {
    const jsonString = this.decoder.decode(bytes);
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
    return this.encoder.encode(jsonString);
  }
}

export { JsonEventSerializer, JsonSnapshotSerializer };
