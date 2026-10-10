import { EventStore } from "event-store-adapter-js";
import { userAccountSerializers } from "./domain/user-account-serializers";
import { runUserAccountExample, unwrap } from "./run-user-account-example";

async function main(): Promise<void> {
  const store = unwrap(EventStore.createMemory(userAccountSerializers()));
  await runUserAccountExample("memory", store);
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
