import { EventStoreFactory } from "event-store-adapter-js";
import {
  convertJSONToUserAccount,
  type UserAccount,
} from "./domain/user-account";
import {
  convertJSONToUserAccountEvent,
  type UserAccountEvent,
} from "./domain/user-account-event";
import type { UserAccountId } from "./domain/user-account-id";
import {
  createJournalTable,
  createSnapshotTable,
  startDynamoDBContainer,
} from "./dynamodb-container";
import { runUserAccountExample } from "./run-user-account-example";

const JOURNAL_TABLE_NAME = "journal";
const SNAPSHOT_TABLE_NAME = "snapshot";
const JOURNAL_AID_INDEX_NAME = "journal-aid-index";
const SNAPSHOT_AID_INDEX_NAME = "snapshot-aid-index";
const SNAPSHOT_ACTIVE_TTL_INDEX_NAME = "snapshot-active-ttl-index";

async function main(): Promise<void> {
  const dynamodb = await startDynamoDBContainer();
  try {
    await createJournalTable(
      dynamodb.client,
      JOURNAL_TABLE_NAME,
      JOURNAL_AID_INDEX_NAME,
    );
    await createSnapshotTable(
      dynamodb.client,
      SNAPSHOT_TABLE_NAME,
      SNAPSHOT_AID_INDEX_NAME,
      SNAPSHOT_ACTIVE_TTL_INDEX_NAME,
    );
    const eventStore = EventStoreFactory.ofDynamoDB<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      client: dynamodb.client,
      journalTableName: JOURNAL_TABLE_NAME,
      snapshotTableName: SNAPSHOT_TABLE_NAME,
      journalAidIndexName: JOURNAL_AID_INDEX_NAME,
      snapshotAidIndexName: SNAPSHOT_AID_INDEX_NAME,
      snapshotActiveTtlIndexName: SNAPSHOT_ACTIVE_TTL_INDEX_NAME,
      shardCount: 32,
      eventConverter: convertJSONToUserAccountEvent,
      snapshotConverter: convertJSONToUserAccount,
    });
    await runUserAccountExample("dynamodb", eventStore);
  } finally {
    await dynamodb.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
