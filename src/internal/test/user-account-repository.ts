import { UserAccountEvent } from "./user-account-event";
import { UserAccountId } from "./user-account-id";
import { UserAccount } from "./user-account";
import { EventStore } from "../../event-store";

class UserAccountRepository {
  constructor(
    private readonly eventStore: EventStore<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >,
  ) {}

  async storeEvent(event: UserAccountEvent, version: number) {
    await this.eventStore.persistEvent(event, version);
  }

  async storeEventAndSnapshot(event: UserAccountEvent, snapshot: UserAccount) {
    await this.eventStore.persistEventAndSnapshot(event, snapshot);
  }

  async findById(id: UserAccountId): Promise<UserAccount | undefined> {
    const snapshot = await this.eventStore.getLatestSnapshotById(id);
    if (snapshot === undefined) {
      return undefined;
    } else {
      const events = await this.eventStore.getEventsByIdSinceSequenceNumber(
        id,
        snapshot.sequenceNumber + 1,
      );
      return UserAccount.replay(events, snapshot);
    }
  }
}

export { UserAccountRepository };
