import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEnvelope, EventStore, EventStoreError, type Result, SnapshotEnvelope } from "event-store-adapter-js";
import { UserAccount } from "./user-account";
import { UserAccountCreated } from "./user-account-created";
import { UserAccountEvent } from "./user-account-event";
import { UserAccountId } from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";
import { UserAccountRepository } from "./user-account-repository";
import { userAccountSerializers } from "./user-account-serializers";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw result.error;
  return result.value;
}

test("domain serializers restore branded values and omit envelope metadata", () => {
  const id = UserAccountId.create("1");
  const [account, event] = UserAccount.create(id, "Alice");
  const serializers = userAccountSerializers();
  const bytes = serializers.eventSerializer.serialize(event);
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(bytes)).data).sort(), ["id", "name"]);
  const restored = serializers.eventSerializer.deserialize(bytes, "UserAccountEvent.v1");
  assert.ok(UserAccountCreated.is(restored) && UserAccountEvent.is(restored));
  assert.deepEqual(UserAccountEvent.toJSON(restored), UserAccountEvent.toJSON(event));
  const renamed = account.rename("Bob")[1];
  assert.ok(UserAccountRenamed.is(serializers.eventSerializer.deserialize(serializers.eventSerializer.serialize(renamed), "UserAccountEvent.v1")));
  const snapshot = serializers.snapshotSerializer.deserialize(serializers.snapshotSerializer.serialize(account), "UserAccount.v1");
  assert.ok(UserAccount.is(snapshot) && UserAccountId.is(snapshot.id));
  assert.equal(snapshot.rename("Bob")[0].name, "Bob");
  assert.throws(() => serializers.eventSerializer.deserialize(bytes, "unknown"));
  assert.throws(() => serializers.snapshotSerializer.deserialize(serializers.snapshotSerializer.serialize(account), ""));
  assert.throws(() => UserAccountEvent.fromJSON({ type: "Unknown" }));
  assert.throws(() => UserAccountId.create(""));
  assert.throws(() => UserAccountId.fromJSON({ typeName: "user-account", value: "1" }));
  assert.throws(() => UserAccountCreated.create({ id: "", name: "Alice" }));
  assert.throws(() => UserAccountRenamed.fromJSON({}));
});

test("repository replays from snapshot+1, and from 1 without a snapshot, never from head", async () => {
  const serializers = userAccountSerializers();
  const actual = unwrap(EventStore.createMemory(serializers));
  const queries: number[] = [];
  const store: EventStore<UserAccountEvent, UserAccount> = {
    ...actual,
    getEventsByIdSinceSeqNr: (id, from) => { queries.push(from); return actual.getEventsByIdSinceSeqNr(id, from); },
  };
  const repository = UserAccountRepository.create(store);
  const id = UserAccountId.create("snapshot");
  const [account, created] = UserAccount.create(id, "Alice");
  const first = unwrap(EventEnvelope.create({ aggregateId: id, seqNr: 1, occurredAt: new Date(0), payload: created }));
  unwrap(await repository.saveWithSnapshot(first, account));
  const second = unwrap(EventEnvelope.create({ ...first, seqNr: 2, payload: account.rename("Bob")[1] }));
  unwrap(await repository.save(second));
  assert.equal(unwrap(await repository.findById(id))?.name, "Bob");
  const other = UserAccountId.create("events");
  const [, event] = UserAccount.create(other, "Dave");
  unwrap(await repository.save(unwrap(EventEnvelope.create({ ...first, aggregateId: other, payload: event }))));
  assert.equal(unwrap(await repository.findById(other))?.name, "Dave");
  assert.equal(unwrap(await repository.findById(UserAccountId.create("missing"))), undefined);
  assert.deepEqual(queries, [2, 1, 1]);
  const latest = unwrap(await store.getLatestSnapshotById(id));
  assert.equal(latest?.headSeqNr, 2);
  assert.equal(latest?.snapshot?.seqNr, 1);
});

test("repository propagates Result and cause on read and envelope construction errors", async () => {
  const cause = new Error("read failed");
  const error = EventStoreError.storage("read failed", cause);
  const actual = unwrap(EventStore.createMemory<UserAccountEvent, UserAccount>());
  const repository = UserAccountRepository.create({ ...actual, getLatestSnapshotById: async () => ({ type: "err", error }) });
  assert.deepEqual(await repository.findById(UserAccountId.create("1")), { type: "err", error });
  const readEvents = UserAccountRepository.create({ ...actual, getEventsByIdSinceSeqNr: async () => ({ type: "err", error }) });
  assert.deepEqual(await readEvents.findById(UserAccountId.create("1")), { type: "err", error });
  const [account, payload] = UserAccount.create(UserAccountId.create("1"), "Alice");
  const malformed = { aggregateId: account.id, seqNr: 0, occurredAt: new Date(0), manifest: "", payload };
  const result = await repository.saveWithSnapshot(malformed, account);
  assert.equal(result.type, "err");
  if (result.type === "err") assert.equal(result.error.type, "contract-violation");
  assert.equal(SnapshotEnvelope.create({ seqNr: 1, aggregate: account }).type, "ok");
});
