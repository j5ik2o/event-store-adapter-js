import { describe } from "node:test";
import { UserAccountId } from "./test/user-account-id";
// import {ulid} from "ulid";
import { UserAccount } from "./test/user-account";
import { UserAccountEvent } from "./test/user-account-event";
import { EventStore } from "../event-store";
import { EventStoreForMemory } from "./event-store-for-memory";

afterEach(() => {
  jest.useRealTimers();
});

describe("EventStoreForDynamoDB", () => {
  const TEST_TIME_FACTOR = parseFloat(process.env.TEST_TIME_FACTOR ?? "1.0");
  const TIMEOUT: number = 10 * 1000 * TEST_TIME_FACTOR;

  let eventStore: EventStore<UserAccountId, UserAccount, UserAccountEvent>;

  function createEventStore(): EventStore<
    UserAccountId,
    UserAccount,
    UserAccountEvent
  > {
    return new EventStoreForMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >(new Map(), new Map());
  }

  beforeAll(async () => {
    eventStore = createEventStore();
  });

  test(
    "persistAndSnapshot",
    async () => {
      const id = new UserAccountId("1");
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
      const id = new UserAccountId("2");
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
});
