import { describe } from "node:test";
import { ulid } from "ulid";
import { type EventStore, EventStoreFactory } from "../event-store";
import { EventStoreForMemory } from "./event-store-for-memory";
import { UserAccount } from "./test/user-account";
import type { UserAccountEvent } from "./test/user-account-event";
import { UserAccountId } from "./test/user-account-id";

afterEach(() => {
  jest.useRealTimers();
});

describe("EventStoreForDynamoDB", () => {
  const TEST_TIME_FACTOR = Number.parseFloat(
    process.env.TEST_TIME_FACTOR ?? "1.0",
  );
  const TIMEOUT: number = 10 * 1000 * TEST_TIME_FACTOR;

  let eventStore: EventStore<UserAccountId, UserAccount, UserAccountEvent>;

  function createEventStore(): EventStore<
    UserAccountId,
    UserAccount,
    UserAccountEvent
  > {
    return EventStoreFactory.ofMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >();
  }

  beforeAll(async () => {
    eventStore = createEventStore();
  });

  test(
    "persistAndSnapshot",
    async () => {
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
    TIMEOUT,
  );

  test(
    "persistAndSnapshot2",
    async () => {
      const id = new UserAccountId(ulid());
      const name = "Alice";
      const [userAccount1, created] = UserAccount.create(id, name);

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
    TIMEOUT,
  );

  test(
    "uses seeded events and snapshots",
    async () => {
      const id = new UserAccountId(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");
      const [userAccount2, renamed] = userAccount1.rename("Bob");
      const seededEventStore = EventStoreFactory.ofMemory<
        UserAccountId,
        UserAccount,
        UserAccountEvent
      >(
        new Map([[id, [created, renamed]]]),
        new Map([[id, userAccount2.withVersion(2)]]),
      );

      const latestSnapshot = await seededEventStore.getLatestSnapshotById(id);
      const events = await seededEventStore.getEventsByIdSinceSequenceNumber(
        id,
        2,
      );

      expect(latestSnapshot?.name).toEqual("Bob");
      expect(latestSnapshot?.version).toEqual(2);
      expect(events).toEqual([renamed]);
    },
    TIMEOUT,
  );

  test(
    "rejects created events in persistEvent",
    async () => {
      const id = new UserAccountId(ulid());
      const [userAccount, created] = UserAccount.create(id, "Alice");
      const seededEventStore = EventStoreFactory.ofMemory<
        UserAccountId,
        UserAccount,
        UserAccountEvent
      >(new Map([[id, []]]), new Map([[id, userAccount]]));

      await expect(seededEventStore.persistEvent(created, 1)).rejects.toThrow(
        "event is created",
      );
    },
    TIMEOUT,
  );

  test(
    "rejects persistEvent when snapshot is missing",
    async () => {
      const id = new UserAccountId(ulid());
      const [userAccount, created] = UserAccount.create(id, "Alice");
      const [, renamed] = userAccount.rename("Bob");
      const seededEventStore = EventStoreFactory.ofMemory<
        UserAccountId,
        UserAccount,
        UserAccountEvent
      >(new Map([[id, [created]]]));

      await expect(seededEventStore.persistEvent(renamed, 1)).rejects.toThrow(
        "snapshot is undefined",
      );
    },
    TIMEOUT,
  );

  test(
    "rejects persistEvent when snapshot id does not match event aggregate id",
    async () => {
      const id = new UserAccountId(ulid());
      const otherId = new UserAccountId(ulid());
      const [userAccount, created] = UserAccount.create(id, "Alice");
      const [, renamed] = userAccount.rename("Bob");
      const mismatchedSnapshot = new UserAccount(otherId, "Alice", 1, 1);
      const seededEventStore = new EventStoreForMemory<
        UserAccountId,
        UserAccount,
        UserAccountEvent
      >(new Map([[id, [created]]]), new Map([[id, mismatchedSnapshot]]));

      await expect(seededEventStore.persistEvent(renamed, 1)).rejects.toThrow(
        "aggregateId",
      );
    },
    TIMEOUT,
  );

  test(
    "rejects persistEvent when version does not match",
    async () => {
      const id = new UserAccountId(ulid());
      const [userAccount, created] = UserAccount.create(id, "Alice");
      const [, renamed] = userAccount.rename("Bob");
      const seededEventStore = EventStoreFactory.ofMemory<
        UserAccountId,
        UserAccount,
        UserAccountEvent
      >(new Map([[id, [created]]]), new Map([[id, userAccount]]));

      await expect(seededEventStore.persistEvent(renamed, 2)).rejects.toThrow(
        "version mismatch",
      );
    },
    TIMEOUT,
  );

  test(
    "rejects persistEvent when event history is missing",
    async () => {
      const id = new UserAccountId(ulid());
      const [userAccount] = UserAccount.create(id, "Alice");
      const [, renamed] = userAccount.rename("Bob");
      const seededEventStore = EventStoreFactory.ofMemory<
        UserAccountId,
        UserAccount,
        UserAccountEvent
      >(new Map(), new Map([[id, userAccount]]));

      await expect(seededEventStore.persistEvent(renamed, 1)).rejects.toThrow(
        "events is undefined",
      );
    },
    TIMEOUT,
  );

  test(
    "rejects missing event history reads",
    async () => {
      const id = new UserAccountId(ulid());
      const seededEventStore = EventStoreFactory.ofMemory<
        UserAccountId,
        UserAccount,
        UserAccountEvent
      >();

      await expect(
        seededEventStore.getEventsByIdSinceSequenceNumber(id, 1),
      ).rejects.toThrow("events is undefined");
    },
    TIMEOUT,
  );

  test(
    "rejects persistEventAndSnapshot when aggregate id does not match",
    async () => {
      const id = new UserAccountId(ulid());
      const otherId = new UserAccountId(ulid());
      const [userAccount, created] = UserAccount.create(id, "Alice");
      const mismatchedAggregate = new UserAccount(otherId, "Alice", 1, 1);

      await expect(
        eventStore.persistEventAndSnapshot(created, mismatchedAggregate),
      ).rejects.toThrow("aggregateId mismatch");

      expect(userAccount.id).toEqual(id);
    },
    TIMEOUT,
  );

  test(
    "rejects persistEventAndSnapshot when update version does not match",
    async () => {
      const id = new UserAccountId(ulid());
      const [userAccount1, created] = UserAccount.create(id, "Alice");
      const [userAccount2, renamed] = userAccount1.rename("Bob");

      await eventStore.persistEventAndSnapshot(created, userAccount1);

      await expect(
        eventStore.persistEventAndSnapshot(
          renamed,
          userAccount2.withVersion(2),
        ),
      ).rejects.toThrow("version mismatch");
    },
    TIMEOUT,
  );
});
