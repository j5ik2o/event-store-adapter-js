import { EventStoreFactory } from "../event-store";
import { runEventStoreContractTests } from "./test/event-store-contract";
import type { UserAccount } from "./test/user-account";
import type { UserAccountEvent } from "./test/user-account-event";
import type { UserAccountId } from "./test/user-account-id";

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
