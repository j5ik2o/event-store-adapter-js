import { ulid } from "ulid";
import type { EventStore } from "../../event-store";
import { OptimisticLockError } from "../../types";
import { UserAccount } from "./user-account";
import type { UserAccountEvent } from "./user-account-event";
import { UserAccountId } from "./user-account-id";

function runEventStoreContractTests(config: {
  name: string;
  timeout: number;
  createEventStore: () =>
    | EventStore<UserAccountId, UserAccount, UserAccountEvent>
    | Promise<EventStore<UserAccountId, UserAccount, UserAccountEvent>>;
}): void {
  describe(config.name, () => {
    test(
      "persists created event and snapshot",
      async () => {
        const eventStore = await config.createEventStore();
        const id = new UserAccountId(ulid());
        const name = "Alice";
        const [userAccount1, created] = UserAccount.create(id, name);

        await eventStore.persistEventAndSnapshot(created, userAccount1);

        const userAccount2 = await eventStore.getLatestSnapshotById(id);
        if (userAccount2 === undefined) {
          throw new Error("userAccount2 is undefined");
        }
        expect(userAccount2.id).toEqual(id);
        expect(userAccount2.name).toEqual(name);
        expect(userAccount2.version).toEqual(1);
      },
      config.timeout,
    );

    test(
      "persists update event and replays events after the latest snapshot",
      async () => {
        const eventStore = await config.createEventStore();
        const id = new UserAccountId(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await eventStore.persistEventAndSnapshot(created, userAccount1);

        const [userAccount2, renamed] = userAccount1.rename("Bob");

        await eventStore.persistEvent(renamed, userAccount2.version);

        const latestSnapshot = await eventStore.getLatestSnapshotById(id);
        if (latestSnapshot === undefined) {
          throw new Error("latestSnapshot is undefined");
        }
        const eventsAfterSnapshot =
          await eventStore.getEventsByIdSinceSequenceNumber(
            id,
            latestSnapshot.sequenceNumber + 1,
          );
        const userAccount3 = UserAccount.replay(
          eventsAfterSnapshot,
          latestSnapshot,
        );

        expect(userAccount3.id).toEqual(id);
        expect(userAccount3.name).toEqual("Bob");
        expect(userAccount3.sequenceNumber).toEqual(2);
        expect(userAccount3.version).toEqual(2);
      },
      config.timeout,
    );

    test(
      "persists update event with a new snapshot",
      async () => {
        const eventStore = await config.createEventStore();
        const id = new UserAccountId(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await eventStore.persistEventAndSnapshot(created, userAccount1);

        const [userAccount2, renamed] = userAccount1.rename("Bob");

        await eventStore.persistEventAndSnapshot(renamed, userAccount2);

        const latestSnapshot = await eventStore.getLatestSnapshotById(id);
        if (latestSnapshot === undefined) {
          throw new Error("latestSnapshot is undefined");
        }
        const eventsAfterSnapshot =
          await eventStore.getEventsByIdSinceSequenceNumber(
            id,
            latestSnapshot.sequenceNumber + 1,
          );
        const userAccount3 = UserAccount.replay(
          eventsAfterSnapshot,
          latestSnapshot,
        );

        expect(userAccount3.id).toEqual(id);
        expect(userAccount3.name).toEqual("Bob");
        expect(userAccount3.sequenceNumber).toEqual(2);
        expect(userAccount3.version).toEqual(2);
      },
      config.timeout,
    );

    test(
      "returns empty reads for an unknown aggregate",
      async () => {
        const eventStore = await config.createEventStore();
        const id = new UserAccountId(ulid());

        await expect(eventStore.getLatestSnapshotById(id)).resolves.toBe(
          undefined,
        );
        await expect(
          eventStore.getEventsByIdSinceSequenceNumber(id, 1),
        ).resolves.toEqual([]);
      },
      config.timeout,
    );

    test(
      "rejects aggregate id mismatch as a caller contract error",
      async () => {
        const eventStore = await config.createEventStore();
        const id = new UserAccountId(ulid());
        const otherId = new UserAccountId(ulid());
        const [aggregate, created] = UserAccount.create(id, "Alice");
        const mismatchedAggregate = new UserAccount(
          otherId,
          aggregate.name,
          aggregate.sequenceNumber,
          aggregate.version,
        );

        await expect(
          eventStore.persistEventAndSnapshot(created, mismatchedAggregate),
        ).rejects.not.toBeInstanceOf(OptimisticLockError);
      },
      config.timeout,
    );

    test(
      "rejects stale versions as optimistic lock errors",
      async () => {
        const eventStore = await config.createEventStore();
        const id = new UserAccountId(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await eventStore.persistEventAndSnapshot(created, userAccount1);

        const [, renamed] = userAccount1.rename("Bob");

        await expect(eventStore.persistEvent(renamed, 0)).rejects.toThrow(
          OptimisticLockError,
        );
      },
      config.timeout,
    );

    test(
      "rejects duplicate created events as optimistic lock errors",
      async () => {
        const eventStore = await config.createEventStore();
        const id = new UserAccountId(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await eventStore.persistEventAndSnapshot(created, userAccount1);

        await expect(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        ).rejects.toThrow(OptimisticLockError);
      },
      config.timeout,
    );
  });
}

export { runEventStoreContractTests };
