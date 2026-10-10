import { strict as assert } from "node:assert";
import { AggregateId, EventEnvelope, type EventStore, type EventStoreError, type Result } from "event-store-adapter-js";
import { ulid } from "ulid";
import { UserAccount } from "./domain/user-account";
import type { UserAccountEvent } from "./domain/user-account-event";
import { UserAccountId } from "./domain/user-account-id";
import { UserAccountRepository } from "./domain/user-account-repository";

export async function runUserAccountExample(backend: string, store: EventStore<UserAccountEvent, UserAccount>): Promise<void> {
  const repository = UserAccountRepository.create(store);
  const id = UserAccountId.create(ulid());
  const [account, created] = UserAccount.create(id, "Alice");
  const first = unwrap(EventEnvelope.create({ aggregateId: id, seqNr: 1, occurredAt: new Date(), manifest: "UserAccountEvent.v1", payload: created }));
  unwrap(await repository.saveWithSnapshot(first, account));
  const [, renamed] = account.rename("Bob");
  const second = unwrap(EventEnvelope.create({ aggregateId: id, seqNr: 2, occurredAt: new Date(), manifest: "UserAccountEvent.v1", payload: renamed }));
  unwrap(await repository.save(second));
  const restored = unwrap(await repository.findById(id));
  assert.ok(restored && UserAccount.is(restored));
  assert.equal(unwrap(AggregateId.asString(restored.id)), unwrap(AggregateId.asString(id)));
  assert.equal(restored.name, "Bob");
  assert.equal(restored.rename("Carol")[0].name, "Carol");
  const duplicate = await repository.save(second);
  assert.equal(duplicate.type, "err");
  if (duplicate.type === "err") assert.equal(duplicate.error.type, "optimistic-lock-conflict");

  const otherId = UserAccountId.create(ulid());
  const [, withoutSnapshot] = UserAccount.create(otherId, "Dave");
  unwrap(await repository.save(unwrap(EventEnvelope.create({ aggregateId: otherId, seqNr: 1, occurredAt: new Date(), payload: withoutSnapshot }))));
  assert.equal(unwrap(await repository.findById(otherId))?.name, "Dave");
  console.log(`[${backend}] four operations, domain restoration, snapshot and event-only replay, optimistic conflict: passed`);
}

export function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message, { cause: result.error });
  return result.value;
}
