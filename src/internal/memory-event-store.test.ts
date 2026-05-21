import { EventStoreFactory } from "../event-store";
import { runEventStoreContractTests } from "./test/event-store-contract";
import { UserAccount } from "./test/user-account";
import type { UserAccountEvent } from "./test/user-account-event";
import { UserAccountId } from "./test/user-account-id";

afterEach(() => {
  jest.useRealTimers();
});

const TEST_TIME_FACTOR = Number.parseFloat(
  process.env.TEST_TIME_FACTOR ?? "1.0",
);
const TIMEOUT: number = 10 * 1000 * TEST_TIME_FACTOR;

runEventStoreContractTests({
  name: "MemoryEventStore",
  timeout: TIMEOUT,
  createEventStore: () =>
    EventStoreFactory.ofMemory<UserAccountId, UserAccount, UserAccountEvent>(),
});

describe("MemoryEventStore input isolation", () => {
  test("does not expose seeded snapshot references", async () => {
    const id = new UserAccountId("user-account-1");
    const [snapshot] = UserAccount.create(id, "Alice");
    const eventStore = EventStoreFactory.ofMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      snapshots: new Map([[id, snapshot]]),
    });

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);
    const latestSnapshotAgain = await eventStore.getLatestSnapshotById(id);

    expect(latestSnapshot).toEqual(snapshot);
    expect(latestSnapshot).not.toBe(snapshot);
    expect(latestSnapshotAgain).toEqual(snapshot);
    expect(latestSnapshotAgain).not.toBe(latestSnapshot);
  });

  test("does not mutate seeded event arrays", async () => {
    const id = new UserAccountId("user-account-2");
    const [snapshot, created] = UserAccount.create(id, "Alice");
    const seededEvents = [created];
    const eventStore = EventStoreFactory.ofMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      events: new Map([[id, seededEvents]]),
      snapshots: new Map([[id, snapshot]]),
    });
    const [renamedSnapshot, renamed] = snapshot.rename("Bob");

    await eventStore.persistEvent(renamed, renamedSnapshot.version);

    expect(seededEvents).toEqual([created]);
  });
});
