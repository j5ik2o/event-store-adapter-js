import { EventStoreFactory } from "event-store-adapter-js";
import type { UserAccount } from "./domain/user-account";
import type { UserAccountEvent } from "./domain/user-account-event";
import type { UserAccountId } from "./domain/user-account-id";
import { runUserAccountExample } from "./run-user-account-example";

async function main(): Promise<void> {
  const eventStore = EventStoreFactory.ofMemory<
    UserAccountId,
    UserAccount,
    UserAccountEvent
  >();
  await runUserAccountExample("memory", eventStore);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
