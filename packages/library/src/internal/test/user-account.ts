import { ulid } from "ulid";
import { UserAccountCreated } from "./user-account-created";
import type { UserAccountEvent } from "./user-account-event";
import {
  convertJSONToUserAccountId,
  type UserAccountId,
} from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

export type UserAccount = {
  typeName: "UserAccount";
  id: UserAccountId;
  name: string;
  sequenceNumber: number;
  version: number;
  withVersion(version: number): UserAccount;
  updateVersion(version: (value: number) => number): UserAccount;
  incrementSequenceNumber(): UserAccount;
  rename(name: string): [UserAccount, UserAccountEvent];
};

export namespace UserAccount {
  export function createSnapshot(
    id: UserAccountId,
    name: string,
    sequenceNumber: number,
    version: number,
  ): UserAccount {
    return createUserAccount(id, name, sequenceNumber, version);
  }

  export function create(
    id: UserAccountId,
    name: string,
  ): [UserAccount, UserAccountEvent] {
    const initialUserAccount = createUserAccount(id, name, 0, 1);
    const userAccount = initialUserAccount.incrementSequenceNumber();
    const event = UserAccountCreated.create({
      id: ulid(),
      aggregateId: id,
      name,
      sequenceNumber: userAccount.sequenceNumber,
      occurredAt: new Date(),
    });
    return [userAccount, event];
  }

  export function replay(
    events: UserAccountEvent[],
    snapshot: UserAccount,
  ): UserAccount {
    return events.reduce(applyEvent, snapshot);
  }
}

Object.freeze(UserAccount);

function createUserAccount(
  id: UserAccountId,
  name: string,
  sequenceNumber: number,
  version: number,
): UserAccount {
  return Object.freeze({
    typeName: "UserAccount",
    id,
    name,
    sequenceNumber,
    version,
    incrementSequenceNumber: () =>
      createUserAccount(id, name, sequenceNumber + 1, version),
    withVersion: (newVersion: number) =>
      createUserAccount(id, name, sequenceNumber, newVersion),
    updateVersion: (update: (value: number) => number) =>
      createUserAccount(id, name, sequenceNumber, update(version)),
    rename: (newName: string): [UserAccount, UserAccountEvent] => {
      const userAccount = createUserAccount(
        id,
        newName,
        sequenceNumber + 1,
        version,
      );
      const event = UserAccountRenamed.create({
        id: ulid(),
        aggregateId: id,
        name: newName,
        sequenceNumber: userAccount.sequenceNumber,
        occurredAt: new Date(),
      });
      return [userAccount, event];
    },
  });
}

function applyEvent(
  userAccount: UserAccount,
  event: UserAccountEvent,
): UserAccount {
  switch (event.typeName) {
    case "UserAccountRenamed":
      return createUserAccount(
        userAccount.id,
        event.name,
        event.sequenceNumber,
        userAccount.version,
      );
    case "UserAccountCreated":
      return userAccount;
    default: {
      const exhaustiveCheck: never = event;
      throw new Error(`Unknown event type: ${exhaustiveCheck}`);
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: JSON deserialization requires dynamic typing
function convertJSONToUserAccount(json: any): UserAccount {
  const id = convertJSONToUserAccountId(json.data.id);
  return UserAccount.createSnapshot(
    id,
    json.data.name,
    json.data.sequenceNumber,
    json.data.version,
  );
}

export { convertJSONToUserAccount };
