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

  deserialize(bytes: Uint8Array, converter: (json: unknown) => E): E {
    const jsonString = this.decoder.decode(bytes);
    const json = JSON.parse(jsonString);
    return convertJson("eventConverter", converter, json);
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
  deserialize(bytes: Uint8Array, converter: (json: unknown) => A): A {
    const jsonString = this.decoder.decode(bytes);
    const obj = JSON.parse(jsonString);
    return convertJson("snapshotConverter", converter, obj);
  }

  serialize(aggregate: A): Uint8Array {
    const jsonString = JSON.stringify({
      type: aggregate.typeName,
      data: aggregate,
    });
    return this.encoder.encode(jsonString);
  }
}

function convertJson<T>(
  converterName: string,
  converter: (json: unknown) => T,
  json: unknown,
): T {
  try {
    return converter(json);
  } catch (error) {
    throw new Error(
      `${converterName} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export { JsonEventSerializer, JsonSnapshotSerializer };
