import { ulid } from "ulid";
import type { EventStore } from "../../event-store";
import type { EventStoreError, Result } from "../../types";
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
        const id = UserAccountId.create(ulid());
        const name = "Alice";
        const [userAccount1, created] = UserAccount.create(id, name);

        await expectOk(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        );

        const userAccount2 = await eventStore.getLatestSnapshotById(id);
        if (userAccount2 === undefined) {
          throw new Error("userAccount2 is undefined");
        }
        expect(userAccount2.id.asString()).toEqual(id.asString());
        expect(userAccount2.name).toEqual(name);
        expect(userAccount2.version).toEqual(1);
      },
      config.timeout,
    );

    test(
      "persists update event and replays events after the latest snapshot",
      async () => {
        const eventStore = await config.createEventStore();
        const id = UserAccountId.create(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await expectOk(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        );

        const [userAccount2, renamed] = userAccount1.rename("Bob");

        await expectOk(eventStore.persistEvent(renamed, userAccount2.version));

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

        expect(userAccount3.id.asString()).toEqual(id.asString());
        expect(userAccount3.name).toEqual("Bob");
        expect(userAccount3.sequenceNumber).toEqual(2);
        expect(userAccount3.version).toEqual(2);
      },
      config.timeout,
    );

    test(
      "persists multiple update events between snapshots",
      async () => {
        const eventStore = await config.createEventStore();
        const id = UserAccountId.create(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await expectOk(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        );

        const [userAccount2, renamedToBob] = userAccount1.rename("Bob");
        await expectOk(
          eventStore.persistEvent(renamedToBob, userAccount2.version),
        );

        const [userAccount3, renamedToCarol] = userAccount2
          .withVersion(userAccount2.version + 1)
          .rename("Carol");
        await expectOk(
          eventStore.persistEvent(renamedToCarol, userAccount3.version),
        );

        const latestSnapshot = await eventStore.getLatestSnapshotById(id);
        if (latestSnapshot === undefined) {
          throw new Error("latestSnapshot is undefined");
        }
        const eventsAfterSnapshot =
          await eventStore.getEventsByIdSinceSequenceNumber(
            id,
            latestSnapshot.sequenceNumber + 1,
          );
        const userAccount4 = UserAccount.replay(
          eventsAfterSnapshot,
          latestSnapshot,
        );

        expect(userAccount4.id.asString()).toEqual(id.asString());
        expect(userAccount4.name).toEqual("Carol");
        expect(userAccount4.sequenceNumber).toEqual(3);
        expect(userAccount4.version).toEqual(3);
      },
      config.timeout,
    );

    test(
      "persists update event with a new snapshot",
      async () => {
        const eventStore = await config.createEventStore();
        const id = UserAccountId.create(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await expectOk(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        );

        const [userAccount2, renamed] = userAccount1.rename("Bob");

        await expectOk(
          eventStore.persistEventAndSnapshot(renamed, userAccount2),
        );

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

        expect(userAccount3.id.asString()).toEqual(id.asString());
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
        const id = UserAccountId.create(ulid());

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
        const id = UserAccountId.create(ulid());
        const otherId = UserAccountId.create(ulid());
        const [aggregate, created] = UserAccount.create(id, "Alice");
        const mismatchedAggregate = UserAccount.createSnapshot(
          otherId,
          aggregate.name,
          aggregate.sequenceNumber,
          aggregate.version,
        );

        let thrown: unknown;
        try {
          await expectOk(
            eventStore.persistEventAndSnapshot(created, mismatchedAggregate),
          );
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("aggregateId mismatch");
      },
      config.timeout,
    );

    test(
      "rejects updates for unknown aggregates as optimistic lock errors",
      async () => {
        const eventStore = await config.createEventStore();
        const id = UserAccountId.create(ulid());
        const [userAccount1] = UserAccount.create(id, "Alice");
        const [userAccount2, renamed] = userAccount1.rename("Bob");

        await expectOptimisticLockConflict(
          eventStore.persistEvent(renamed, userAccount2.version),
        );
      },
      config.timeout,
    );

    test(
      "rejects stale versions as optimistic lock errors",
      async () => {
        const eventStore = await config.createEventStore();
        const id = UserAccountId.create(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await expectOk(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        );

        const [, renamed] = userAccount1.rename("Bob");

        await expectOptimisticLockConflict(eventStore.persistEvent(renamed, 0));
      },
      config.timeout,
    );

    test(
      "rejects duplicate created events as optimistic lock errors",
      async () => {
        const eventStore = await config.createEventStore();
        const id = UserAccountId.create(ulid());
        const [userAccount1, created] = UserAccount.create(id, "Alice");

        await expectOk(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        );

        await expectOptimisticLockConflict(
          eventStore.persistEventAndSnapshot(created, userAccount1),
        );
      },
      config.timeout,
    );
  });
}

async function expectOk(
  resultPromise: Promise<Result<void, EventStoreError>>,
): Promise<void> {
  const result = await resultPromise;
  expect(result).toEqual({ type: "ok", value: undefined });
}

async function expectOptimisticLockConflict(
  resultPromise: Promise<Result<void, EventStoreError>>,
): Promise<void> {
  const result = await resultPromise;
  expect(result.type).toBe("err");
  if (result.type !== "err") {
    return;
  }
  expect(result.error.type).toBe("optimistic-lock-conflict");
}

export { runEventStoreContractTests };
