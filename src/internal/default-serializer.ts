import type {
  Aggregate,
  AggregateId,
  Event,
  EventSerializer,
  SnapshotSerializer,
} from "../types";

class JsonEventSerializer<AID extends AggregateId, E extends Event<AID>>
  implements EventSerializer<AID, E>
{
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  // biome-ignore lint/suspicious/noExplicitAny:
  deserialize(bytes: Uint8Array, converter: (json: any) => E): E {
    const jsonString = this.decoder.decode(bytes);
    const json = JSON.parse(jsonString);
    return converter(json);
  }

  serialize(event: E): Uint8Array {
    const jsonString = JSON.stringify({
      type: event.typeName,
      data: event,
    });
    return this.encoder.encode(jsonString);
  }
}

class JsonSnapshotSerializer<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
> implements SnapshotSerializer<AID, A>
{
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  // biome-ignore lint/suspicious/noExplicitAny:
  deserialize(bytes: Uint8Array, converter: (json: any) => A): A {
    const jsonString = this.decoder.decode(bytes);
    const obj = JSON.parse(jsonString);
    return converter(obj);
  }

  serialize(aggregate: A): Uint8Array {
    const jsonString = JSON.stringify({
      type: aggregate.typeName,
      data: aggregate,
    });
    return this.encoder.encode(jsonString);
  }
}

export { JsonEventSerializer, JsonSnapshotSerializer };
