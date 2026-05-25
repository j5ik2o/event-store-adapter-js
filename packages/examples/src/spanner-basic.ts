import { EventStore } from "event-store-adapter-js";
import {
  convertJSONToUserAccount,
  type UserAccount,
} from "./domain/user-account";
import {
  convertJSONToUserAccountEvent,
  type UserAccountEvent,
} from "./domain/user-account-event";
import type { UserAccountId } from "./domain/user-account-id";
import { runUserAccountExample } from "./run-user-account-example";
import { startSpannerContainer } from "./spanner-container";

const JOURNAL_TABLE_NAME = "journal";
const SNAPSHOT_TABLE_NAME = "snapshot";

async function main(): Promise<void> {
  const spanner = await startSpannerContainer({
    instanceId: "example-instance",
    databaseId: "example-database",
    journalTableName: JOURNAL_TABLE_NAME,
    snapshotTableName: SNAPSHOT_TABLE_NAME,
  });
  try {
    const eventStore = EventStore.createSpanner<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      database: spanner.database,
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
      shardCount: 32,
      eventConverter: convertJSONToUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
    });
    await runUserAccountExample("spanner", eventStore);
  } finally {
    await spanner.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
