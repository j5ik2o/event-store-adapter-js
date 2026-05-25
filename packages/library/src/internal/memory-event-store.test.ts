import { EventStore } from "../event-store";
import type { EventStoreError, Result } from "../types";
import { createMemoryEventStore } from "./memory-event-store";
import { runEventStoreContractTests } from "./test/event-store-contract";
import { UserAccount } from "./test/user-account";
import type { UserAccountEvent } from "./test/user-account-event";
import { UserAccountId } from "./test/user-account-id";

type SameReferenceAggregate = {
  typeName: "SameReferenceAggregate";
  id: UserAccountId;
  sequenceNumber: number;
  version: number;
  withVersion(version: number): SameReferenceAggregate;
  updateVersion(version: (value: number) => number): SameReferenceAggregate;
};

const SameReferenceAggregate = Object.freeze({
  create(id: UserAccountId, version: number): SameReferenceAggregate {
    const aggregate: SameReferenceAggregate = Object.freeze({
      typeName: "SameReferenceAggregate",
      id,
      sequenceNumber: 1,
      version,
      withVersion: () => aggregate,
      updateVersion: () => aggregate,
    });
    return aggregate;
  },
});

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
    EventStore.createMemory<UserAccountId, UserAccount, UserAccountEvent>(),
});

describe("MemoryEventStore input isolation", () => {
  test("creates an empty store with the internal default input", async () => {
    const eventStore = createMemoryEventStore<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >();
    await expect(
      eventStore.getLatestSnapshotById(UserAccountId.create("0")),
    ).resolves.toBeUndefined();
  });

  test("uses seeded events and snapshots", async () => {
    const id = UserAccountId.create("user-account-0");
    const [userAccount1, created] = UserAccount.create(id, "Alice");
    const [userAccount2, renamed] = userAccount1.rename("Bob");
    const eventStore = EventStore.createMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      events: new Map([[id, [created, renamed]]]),
      snapshots: new Map([[id, userAccount2.withVersion(2)]]),
    });

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);
    const events = await eventStore.getEventsByIdSinceSequenceNumber(id, 2);

    expect(latestSnapshot?.name).toEqual("Bob");
    expect(latestSnapshot?.version).toEqual(2);
    expect(events).toEqual([renamed]);
  });

  test("does not expose seeded snapshot references", async () => {
    const id = UserAccountId.create("user-account-1");
    const [snapshot] = UserAccount.create(id, "Alice");
    const eventStore = EventStore.createMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      snapshots: new Map([[id, snapshot]]),
    });

    const latestSnapshot = await eventStore.getLatestSnapshotById(id);
    const latestSnapshotAgain = await eventStore.getLatestSnapshotById(id);

    expect(latestSnapshot?.id.asString()).toEqual(snapshot.id.asString());
    expect(latestSnapshot?.name).toEqual(snapshot.name);
    expect(latestSnapshot?.sequenceNumber).toEqual(snapshot.sequenceNumber);
    expect(latestSnapshot?.version).toEqual(snapshot.version);
    expect(latestSnapshot).not.toBe(snapshot);
    expect(latestSnapshotAgain?.id.asString()).toEqual(snapshot.id.asString());
    expect(latestSnapshotAgain?.name).toEqual(snapshot.name);
    expect(latestSnapshotAgain?.sequenceNumber).toEqual(
      snapshot.sequenceNumber,
    );
    expect(latestSnapshotAgain?.version).toEqual(snapshot.version);
    expect(latestSnapshotAgain).not.toBe(latestSnapshot);
  });

  test("rejects snapshot copies that keep the same aggregate reference", () => {
    const id = UserAccountId.create("2");
    const snapshot = SameReferenceAggregate.create(id, 1);

    expect(() =>
      EventStore.createMemory<
        UserAccountId,
        SameReferenceAggregate,
        UserAccountEvent
      >({
        snapshots: new Map([[id, snapshot]]),
      }),
    ).toThrow(
      "Invalid seeded snapshot for aggregate user-account-2: Aggregate.withVersion must return a new instance for aggregate user-account-2",
    );
  });

  test("rejects seeded snapshot copy failures with non-error causes", () => {
    const id = UserAccountId.create("8");
    const snapshot: SameReferenceAggregate = {
      ...SameReferenceAggregate.create(id, 1),
      withVersion: () => {
        throw "copy failed";
      },
    };

    expect(() =>
      EventStore.createMemory<
        UserAccountId,
        SameReferenceAggregate,
        UserAccountEvent
      >({
        snapshots: new Map([[id, snapshot]]),
      }),
    ).toThrow(
      "Invalid seeded snapshot for aggregate user-account-8: copy failed",
    );
  });

  test("does not mutate seeded event arrays", async () => {
    const id = UserAccountId.create("user-account-3");
    const [snapshot, created] = UserAccount.create(id, "Alice");
    const seededEvents = [created];
    const eventStore = EventStore.createMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      events: new Map([[id, seededEvents]]),
      snapshots: new Map([[id, snapshot]]),
    });
    const [renamedSnapshot, renamed] = snapshot.rename("Bob");

    await expectOk(eventStore.persistEvent(renamed, renamedSnapshot.version));

    expect(seededEvents).toEqual([created]);
  });

  test("rejects seeded snapshot aggregate id mismatches", async () => {
    const id = UserAccountId.create("user-account-4");
    const otherId = UserAccountId.create("user-account-5");
    const [snapshot] = UserAccount.create(otherId, "Alice");
    const eventStore = EventStore.createMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      // Seed a snapshot under `id` even though the snapshot itself belongs to
      // `otherId`; this simulates corrupted input state.
      snapshots: new Map([[id, snapshot]]),
    });
    const aggregate = UserAccount.createSnapshot(
      id,
      "Bob",
      1,
      snapshot.version,
    );
    const [renamedSnapshot, renamed] = aggregate.rename("Bob");

    await expect(
      eventStore.persistEvent(renamed, renamedSnapshot.version),
    ).rejects.toThrow("aggregateId mismatch");
  });

  test("rejects snapshot updates for missing aggregates", async () => {
    const id = UserAccountId.create("user-account-6");
    const [aggregate, created] = UserAccount.create(id, "Alice");
    const eventStore = EventStore.createMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      events: new Map([[id, [created]]]),
    });
    const [, renamed] = aggregate.rename("Bob");

    await expectErr(
      eventStore.persistEventAndSnapshot(renamed, aggregate),
      "optimistic-lock-conflict",
    );
  });

  test("rejects stale snapshot updates", async () => {
    const id = UserAccountId.create("user-account-7");
    const [aggregate, created] = UserAccount.create(id, "Alice");
    const [renamedAggregate, renamed] = aggregate.rename("Bob");
    const eventStore = EventStore.createMemory<
      UserAccountId,
      UserAccount,
      UserAccountEvent
    >({
      events: new Map([[id, [created]]]),
      snapshots: new Map([[id, aggregate.withVersion(2)]]),
    });

    await expectErr(
      eventStore.persistEventAndSnapshot(renamed, renamedAggregate),
      "optimistic-lock-conflict",
    );
  });
});

async function expectOk(
  resultPromise: Promise<Result<void, EventStoreError>>,
): Promise<void> {
  const result = await resultPromise;
  expect(result).toEqual({ type: "ok", value: undefined });
}

async function expectErr(
  resultPromise: Promise<Result<void, EventStoreError>>,
  type: EventStoreError["type"],
): Promise<void> {
  const result = await resultPromise;
  expect(result.type).toBe("err");
  if (result.type !== "err") {
    return;
  }
  expect(result.error.type).toBe(type);
}
