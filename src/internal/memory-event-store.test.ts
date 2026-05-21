import { EventStoreFactory } from "../event-store";
import type { Aggregate } from "../types";
import { runEventStoreContractTests } from "./test/event-store-contract";
import { UserAccount } from "./test/user-account";
import type { UserAccountEvent } from "./test/user-account-event";
import { UserAccountId } from "./test/user-account-id";

class SameReferenceAggregate
  implements Aggregate<SameReferenceAggregate, UserAccountId>
{
  public readonly typeName: string = "SameReferenceAggregate";
  public readonly sequenceNumber: number = 1;

  constructor(
    public readonly id: UserAccountId,
    public readonly version: number,
  ) {}

  withVersion(_version: number): SameReferenceAggregate {
    return this;
  }

  updateVersion(_version: (value: number) => number): SameReferenceAggregate {
    return this;
  }
}

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

  test("rejects snapshot copies that keep the same aggregate reference", () => {
    const id = new UserAccountId("user-account-2");
    const snapshot = new SameReferenceAggregate(id, 1);

    expect(() =>
      EventStoreFactory.ofMemory<
        UserAccountId,
        SameReferenceAggregate,
        UserAccountEvent
      >({
        snapshots: new Map([[id, snapshot]]),
      }),
    ).toThrow("Aggregate.withVersion must return a new instance");
  });

  test("does not mutate seeded event arrays", async () => {
    const id = new UserAccountId("user-account-3");
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

  test("rejects seeded snapshot aggregate id mismatches", async () => {
    const id = new UserAccountId("user-account-4");
    const otherId = new UserAccountId("user-account-5");
    const [snapshot] = UserAccount.create(otherId, "Alice");
    const eventStore = EventStoreFactory.ofMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      // Seed a snapshot under `id` even though the snapshot itself belongs to
      // `otherId`; this simulates corrupted input state.
      snapshots: new Map([[id, snapshot]]),
    });
    const aggregate = new UserAccount(id, "Bob", 1, snapshot.version);
    const [renamedSnapshot, renamed] = aggregate.rename("Bob");

    await expect(
      eventStore.persistEvent(renamed, renamedSnapshot.version),
    ).rejects.toThrow("aggregateId mismatch");
  });
});
