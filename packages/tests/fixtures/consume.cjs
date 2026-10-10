const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const library = require("event-store-adapter-js");
const { AggregateId, EventEnvelope, EventStore, MemoryStorage, PayloadSerializer, SnapshotEnvelope } = library;

class Amount {
  constructor(value) { this.value = value; }
  plus(value) { return new Amount(this.value + value); }
}

function unwrap(result) {
  if (result.type === "err") throw new Error(result.error.message, { cause: result.error });
  return result.value;
}

function serializers() {
  const serializer = {
    serialize: (amount) => Buffer.from(JSON.stringify({ value: amount.value })),
    deserialize: (bytes, manifest) => {
      assert.equal(manifest, "Amount.v1");
      return new Amount(JSON.parse(Buffer.from(bytes).toString("utf8")).value);
    },
  };
  return { eventSerializer: serializer, snapshotSerializer: serializer };
}

async function consumeFourOperations(store) {
  const id = unwrap(AggregateId.of("Amount", "1"));
  const first = unwrap(EventEnvelope.create({ aggregateId: id, seqNr: 1, occurredAt: new Date(123), manifest: "Amount.v1", payload: new Amount(5) }));
  const snapshot = unwrap(SnapshotEnvelope.create({ seqNr: 1, manifest: "Amount.v1", aggregate: new Amount(5) }));
  unwrap(await store.persistEventAndSnapshot(first, snapshot));
  const second = unwrap(EventEnvelope.create({ ...first, seqNr: 2, payload: new Amount(7) }));
  unwrap(await store.persistEvent(second));
  const latest = unwrap(await store.getLatestSnapshotById(id));
  assert.equal(latest.headSeqNr, 2);
  assert.equal(latest.snapshot.seqNr, 1);
  assert.ok(latest.snapshot.aggregate instanceof Amount);
  const events = unwrap(await store.getEventsByIdSinceSeqNr(id, latest.snapshot.seqNr + 1));
  assert.equal(events.length, 1);
  assert.ok(events[0].payload instanceof Amount);
  assert.equal(latest.snapshot.aggregate.plus(events[0].payload.value).value, 12);
  assert.equal(events[0].occurredAt.getTime(), 123);
  assert.equal(events[0].manifest, "Amount.v1");
  assert.equal(unwrap(await store.getEventsByIdSinceSeqNr(id, 1)).length, 2);
  const conflict = await store.persistEvent(second);
  assert.equal(conflict.type, "err");
  assert.equal(conflict.error.type, "optimistic-lock-conflict");
  return id;
}

async function consumeMemory() {
  for (const id of [
    { typeName: "\uD800", value: "1" },
    { typeName: "\uDC00", value: "1" },
    { typeName: "Order", value: "\uD800" },
    { typeName: "Order", value: "\uD801" },
    { typeName: "Order", value: "\uDC00" },
  ]) {
    for (const result of [AggregateId.of(id.typeName, id.value), AggregateId.asString(id)]) {
      assert.equal(result.type, "err");
      assert.equal(result.error.type, "contract-violation");
      assert.equal(result.error.rule, "T-12");
    }
  }
  for (const input of [
    { typeName: "\uD83D\uDE80", value: "\uD83D\uDE03" },
    { typeName: "", value: "" },
    { typeName: "型", value: `${"あ".repeat(339)}abc` },
  ]) {
    const id = unwrap(AggregateId.of(input.typeName, input.value));
    assert.deepEqual(id, input);
    assert.equal(unwrap(AggregateId.asString(id)), `${input.typeName}-${input.value}`);
  }
  const reads = { typeName: 0, value: 0 };
  const changingId = new Proxy({ typeName: "Order", value: "1" }, {
    get(target, key, receiver) {
      if (key === "typeName") return ++reads.typeName === 1 ? "Order" : "invalid-type";
      if (key === "value") return ++reads.value === 1 ? "1" : "x".repeat(1025);
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(unwrap(AggregateId.asString(changingId)), "Order-1");
  assert.deepEqual(reads, { typeName: 1, value: 1 });
  const accessCause = new Error("ID access failed");
  const unreadableId = AggregateId.asString({ get typeName() { throw accessCause; }, value: "1" });
  assert.equal(unreadableId.type, "err");
  assert.equal(unreadableId.error.type, "contract-violation");
  assert.equal(unreadableId.error.rule, "T-2");
  assert.equal(unreadableId.error.cause, accessCause);
  const configurationCause = new Error("configuration access failed");
  for (const [fieldName, create] of [
    ["eventSerializer", () => EventStore.createMemory({ get eventSerializer() { throw configurationCause; } })],
    ["storage", () => EventStore.createMemory({ get storage() { throw configurationCause; } })],
    ["retention", () => MemoryStorage.create({ get retention() { throw configurationCause; } })],
  ]) {
    const rejected = create();
    assert.equal(rejected.type, "err");
    assert.equal(rejected.error.type, "configuration-error");
    assert.equal(rejected.error.fieldName, fieldName);
    assert.equal(rejected.error.cause, configurationCause);
  }
  const storage = unwrap(MemoryStorage.create());
  const store = unwrap(EventStore.createMemory({ storage, ...serializers() }));
  const id = await consumeFourOperations(store);
  const shared = unwrap(EventStore.createMemory({ storage, ...serializers() }));
  assert.equal(unwrap(await shared.getLatestSnapshotById(id)).headSeqNr, 2);
  const isolated = unwrap(EventStore.createMemory());
  const otherStorage = unwrap(EventStore.createMemory({ storage: unwrap(MemoryStorage.create()) }));
  assert.equal(unwrap(await isolated.getLatestSnapshotById(id)), undefined);
  assert.equal(unwrap(await otherStorage.getLatestSnapshotById(id)), undefined);
  const cause = new Error("domain serialization failed");
  const broken = unwrap(EventStore.createMemory({ eventSerializer: { ...PayloadSerializer.json(), serialize: () => { throw cause; } } }));
  const event = unwrap(EventEnvelope.create({ aggregateId: id, seqNr: 1, occurredAt: new Date(0), payload: {} }));
  const result = await broken.persistEvent(event);
  assert.equal(result.type, "err");
  assert.equal(result.error.type, "serialization-error");
  assert.equal(result.error.cause, cause);
  assert.equal(unwrap(await broken.getLatestSnapshotById(id)), undefined);
  for (const operation of ["persistEvent", "persistEventAndSnapshot"]) {
    for (const kind of ["detached", "proxy"]) {
      let bytes = Uint8Array.of(1);
      const copyCause = new TypeError("bytes iteration failed");
      if (kind === "detached") structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      else bytes = new Proxy(bytes, { get(target, key, receiver) {
        if (key === Symbol.iterator) throw copyCause;
        return Reflect.get(target, key, receiver);
      } });
      const unreadable = unwrap(EventStore.createMemory({ eventSerializer: { ...PayloadSerializer.json(), serialize: () => bytes } }));
      const failed = operation === "persistEvent"
        ? await unreadable.persistEvent(event)
        : await unreadable.persistEventAndSnapshot(event, { seqNr: 1, manifest: "snapshot", aggregate: {} });
      assert.equal(failed.type, "err");
      assert.equal(failed.error.type, "serialization-error");
      assert.equal(failed.error.operation, "serialize");
      assert.ok(failed.error.cause instanceof TypeError);
      if (kind === "proxy") assert.equal(failed.error.cause, copyCause);
      assert.equal(unwrap(await unreadable.getLatestSnapshotById(id)), undefined);
      assert.deepEqual(unwrap(await unreadable.getEventsByIdSinceSeqNr(id, 1)), []);
    }
  }
  const scratch = Buffer.from('{"count":1}');
  const copied = unwrap(EventStore.createMemory({ eventSerializer: { ...PayloadSerializer.json(), serialize: () => scratch } }));
  const pending = copied.persistEvent(event);
  scratch.fill(0);
  unwrap(await pending);
  assert.deepEqual(unwrap(await copied.getEventsByIdSinceSeqNr(id, 1))[0].payload, { count: 1 });
  scratch.fill(99);
  assert.deepEqual(unwrap(await copied.getEventsByIdSinceSeqNr(id, 1))[0].payload, { count: 1 });
}

async function consumeDynamoDB(layout) {
  const { DynamoDBClient } = createRequire(require.resolve("event-store-adapter-js"))("@aws-sdk/client-dynamodb");
  const cause = new Error("client access failed");
  const rejected = await EventStore.createDynamoDB({ get client() { throw cause; }, tables: layout.tables, snapshotAidIndexName: layout.snapshotAidIndexName });
  assert.equal(rejected.type, "err");
  assert.equal(rejected.error.type, "configuration-error");
  assert.equal(rejected.error.fieldName, "client");
  assert.equal(rejected.error.cause, cause);
  const client = new DynamoDBClient({ region: "us-west-1", endpoint: layout.endpoint, credentials: { accessKeyId: "dynamodblocal", secretAccessKey: "test-only" }, maxAttempts: 1 });
  try {
    const store = unwrap(await EventStore.createDynamoDB({ client, tables: layout.tables, snapshotAidIndexName: layout.snapshotAidIndexName, ...serializers() }));
    await consumeFourOperations(store);
    const reopened = unwrap(await EventStore.createDynamoDB({ client, tables: layout.tables, snapshotAidIndexName: layout.snapshotAidIndexName, ...serializers() }));
    const read = unwrap(await reopened.getLatestSnapshotById({ typeName: "Amount", value: "1" }));
    assert.equal(read.snapshot.aggregate.plus(1).value, 6);
  } finally { client.destroy(); }
}

module.exports = { consumeMemory, consumeDynamoDB };
if (require.main === module) {
  (async () => {
    await consumeMemory();
    await consumeDynamoDB(JSON.parse(process.env.ESWA_DYNAMODB_LAYOUT));
    console.log("External package: Unicode IDs, ID access, creation Result/cause, byte copy classification and isolation, four operations, domain serializers, Result/cause, Memory sharing and isolation passed");
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
