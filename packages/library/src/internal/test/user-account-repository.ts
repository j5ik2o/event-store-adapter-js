import type { EventStore, EventStoreError, Result } from "../../types";
import {
  UserAccount,
  type UserAccount as UserAccountType,
} from "./user-account";
import type { UserAccountEvent } from "./user-account-event";
import type { UserAccountId } from "./user-account-id";

export type UserAccountRepository = Readonly<{
  storeEvent(
    event: UserAccountEvent,
    version: number,
  ): Promise<Result<void, EventStoreError>>;
  storeEventAndSnapshot(
    event: UserAccountEvent,
    snapshot: UserAccountType,
  ): Promise<Result<void, EventStoreError>>;
  findById(id: UserAccountId): Promise<UserAccountType | undefined>;
}>;

export namespace UserAccountRepository {
  export function create(
    eventStore: EventStore<UserAccountId, UserAccountType, UserAccountEvent>,
  ): UserAccountRepository {
    return Object.freeze({
      storeEvent: (event: UserAccountEvent, version: number) =>
        eventStore.persistEvent(event, version),
      storeEventAndSnapshot: (
        event: UserAccountEvent,
        snapshot: UserAccountType,
      ) => eventStore.persistEventAndSnapshot(event, snapshot),
      async findById(id: UserAccountId): Promise<UserAccountType | undefined> {
        const snapshot = await eventStore.getLatestSnapshotById(id);
        if (snapshot === undefined) {
          return undefined;
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
