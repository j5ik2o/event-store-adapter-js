import { AggregateId, EventEnvelope, EventStore, type EventStoreError, MemoryStorage, type PayloadSerializer, type Result, SnapshotEnvelope } from "event-store-adapter-js";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

class Amount {
  constructor(readonly value: number) {}
  plus(value: number): Amount { return new Amount(this.value + value); }
}
const serializer: PayloadSerializer<Amount> = {
  serialize: (amount) => new TextEncoder().encode(JSON.stringify({ value: amount.value })),
  deserialize: (bytes, manifest) => {
    if (manifest !== "Amount.v1") throw new Error("manifest");
    return new Amount(JSON.parse(new TextDecoder().decode(bytes)).value);
  },
};
function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw result.error.cause ?? result.error;
  return result.value;
}
export async function consume(client: DynamoDBClient): Promise<number> {
  const storage = unwrap(MemoryStorage.create());
  const memory = unwrap(EventStore.createMemory({ storage, eventSerializer: serializer, snapshotSerializer: serializer }));
  const dynamodb = unwrap(await EventStore.createDynamoDB({ client, tables: { journal: "journal", snapshot: "snapshot", head: "head" }, snapshotAidIndexName: "history", eventSerializer: serializer, snapshotSerializer: serializer }));
  for (const store of [memory, dynamodb]) {
    const id = unwrap(AggregateId.of("Amount", "1"));
    const event = unwrap(EventEnvelope.create({ aggregateId: id, seqNr: 1, occurredAt: new Date(), manifest: "Amount.v1", payload: new Amount(5) }));
    const snapshot = unwrap(SnapshotEnvelope.create({ seqNr: 1, manifest: "Amount.v1", aggregate: new Amount(5) }));
    unwrap(await store.persistEventAndSnapshot(event, snapshot));
    unwrap(await store.persistEvent(unwrap(EventEnvelope.create({ ...event, seqNr: 2 }))));
    const latest = unwrap(await store.getLatestSnapshotById(id));
    const events = unwrap(await store.getEventsByIdSinceSeqNr(id, latest?.snapshot === undefined ? 1 : latest.snapshot.seqNr + 1));
    if (events.length !== 1) throw new Error("events");
    const amount: Amount = events[0].payload;
    if (amount.plus(1).value !== 6) throw new Error("domain");
  }
  return 6;
}
