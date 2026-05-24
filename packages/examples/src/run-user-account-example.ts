import { strict as assert } from "node:assert";
import type {
  EventStore,
  EventStoreError,
  Result,
} from "event-store-adapter-js";
import { ulid } from "ulid";
import { UserAccount } from "./domain/user-account";
import type { UserAccountEvent } from "./domain/user-account-event";
import { UserAccountId } from "./domain/user-account-id";
import { UserAccountRepository } from "./domain/user-account-repository";

async function runUserAccountExample(
  backendName: string,
  eventStore: EventStore<UserAccountId, UserAccount, UserAccountEvent>,
): Promise<void> {
  console.log(`[${backendName}] starting example`);

  const userAccountRepository = UserAccountRepository.create(eventStore);
  const id = UserAccountId.create(ulid());
  const [createdAccount, created] = UserAccount.create(id, "Alice");

  assertOk(await userAccountRepository.saveWithSnapshot(created, createdAccount));
  console.log(`[${backendName}] created user account: Alice`);

  const [, renamed] = createdAccount.rename("Bob");
  assertOk(await userAccountRepository.save(renamed, createdAccount.version));
  console.log(`[${backendName}] renamed user account: Bob`);

  const replayedAccount = await userAccountRepository.findById(id);
  assert(replayedAccount !== undefined);
  assert.equal(replayedAccount.id.asString(), id.asString());
  assert.equal(replayedAccount.name, "Bob");
  assert.equal(replayedAccount.version, 2);
  assert.equal(replayedAccount.sequenceNumber, 2);
  console.log(
    `[${backendName}] replayed user account: ${replayedAccount.name}, version=${replayedAccount.version}, sequenceNumber=${replayedAccount.sequenceNumber}`,
  );

  const [, staleRename] = replayedAccount.rename("Carol");
  const staleResult = await userAccountRepository.save(staleRename, 1);
  if (
    staleResult.type !== "err" ||
    staleResult.error.type !== "optimistic-lock-conflict"
  ) {
    throw new Error(`[${backendName}] expected optimistic lock conflict`);
  }
  console.log(`[${backendName}] detected optimistic lock error`);

  console.log(`[${backendName}] done`);
}

function assertOk(result: Result<void, EventStoreError>): void {
  if (result.type === "err") {
    throw new Error(result.error.message);
  }
}

export { runUserAccountExample };
