import { strict as assert } from "node:assert";
import { type EventStore, OptimisticLockError } from "event-store-adapter-js";
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

  const userAccountRepository = new UserAccountRepository(eventStore);
  const id = new UserAccountId(ulid());
  const [createdAccount, created] = UserAccount.create(id, "Alice");

  await userAccountRepository.saveWithSnapshot(created, createdAccount);
  console.log(`[${backendName}] created user account: Alice`);

  const [, renamed] = createdAccount.rename("Bob");
  await userAccountRepository.save(renamed, createdAccount.version);
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
  await assertOptimisticLockError(
    () => userAccountRepository.save(staleRename, 1),
    backendName,
  );

  console.log(`[${backendName}] done`);
}

async function assertOptimisticLockError(
  run: () => Promise<void>,
  backendName: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OptimisticLockError) {
      console.log(`[${backendName}] detected optimistic lock error`);
      return;
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`[${backendName}] unexpected error: ${String(error)}`);
  }
  throw new Error(
    `[${backendName}] expected OptimisticLockError but none was thrown`,
  );
}

export { runUserAccountExample };
