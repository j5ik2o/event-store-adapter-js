import { type EventEnvelope, type EventStore, type EventStoreError, Result, SnapshotEnvelope } from "event-store-adapter-js";
import { UserAccount } from "./user-account";
import type { UserAccountEvent } from "./user-account-event";
import type { UserAccountId } from "./user-account-id";

export type UserAccountRepository = Readonly<{
  saveWithSnapshot(event: EventEnvelope<UserAccountEvent>, account: UserAccount): Promise<Result<void, EventStoreError>>;
  save(event: EventEnvelope<UserAccountEvent>): Promise<Result<void, EventStoreError>>;
  findById(id: UserAccountId): Promise<Result<UserAccount | undefined, EventStoreError>>;
}>;

export namespace UserAccountRepository {
  export function create(store: EventStore<UserAccountEvent, UserAccount>): UserAccountRepository {
    return Object.freeze({
      async saveWithSnapshot(event, account) {
        const snapshot = SnapshotEnvelope.create({ seqNr: event.seqNr, aggregate: account, manifest: "UserAccount.v1" });
        if (snapshot.type === "err") return snapshot;
        return store.persistEventAndSnapshot(event, snapshot.value);
      },
      save: (event) => store.persistEvent(event),
      async findById(id) {
        const latest = await store.getLatestSnapshotById(id);
        if (latest.type === "err") return latest;
        const snapshot = latest.value?.snapshot;
        const events = await store.getEventsByIdSinceSeqNr(id, snapshot === undefined ? 1 : snapshot.seqNr + 1);
        if (events.type === "err") return events;
        const payloads = events.value.map((event) => event.payload);
        return Result.ok(snapshot === undefined ? UserAccount.replayFromEvents(id, payloads) : UserAccount.replay(payloads, snapshot.aggregate));
      },
    });
  }
}
Object.freeze(UserAccountRepository);
