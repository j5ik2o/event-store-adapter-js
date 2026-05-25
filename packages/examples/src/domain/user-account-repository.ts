import type { EventStore, EventStoreError, Result } from "event-store-adapter-js";
import { UserAccount } from "./user-account";
import type { UserAccountEvent } from "./user-account-event";
import type { UserAccountId } from "./user-account-id";

export type UserAccountRepository = Readonly<{
  saveWithSnapshot(
    event: UserAccountEvent,
    userAccount: UserAccount,
  ): Promise<Result<void, EventStoreError>>;
  save(
    event: UserAccountEvent,
    expectedVersion: number,
  ): Promise<Result<void, EventStoreError>>;
  findById(id: UserAccountId): Promise<UserAccount | undefined>;
}>;

export namespace UserAccountRepository {
  export function create(
    eventStore: EventStore<UserAccountId, UserAccount, UserAccountEvent>,
  ): UserAccountRepository {
    return Object.freeze({
      saveWithSnapshot: (event, userAccount) =>
        eventStore.persistEventAndSnapshot(event, userAccount),
      save: (event, expectedVersion) =>
        eventStore.persistEvent(event, expectedVersion),
      async findById(id: UserAccountId): Promise<UserAccount | undefined> {
        const snapshot = await eventStore.getLatestSnapshotById(id);
        if (snapshot === undefined) {
          const events = await eventStore.getEventsByIdSinceSequenceNumber(
            id,
            1,
          );
          return UserAccount.replayFromEvents(events);
        }
        const events = await eventStore.getEventsByIdSinceSequenceNumber(
          id,
          snapshot.sequenceNumber + 1,
        );
        return UserAccount.replay(events, snapshot);
      },
    });
  }
}

Object.freeze(UserAccountRepository);
