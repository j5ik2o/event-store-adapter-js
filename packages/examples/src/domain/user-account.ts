import { ulid } from "ulid";
import { UserAccountCreated } from "./user-account-created";
import type { UserAccountEvent } from "./user-account-event";
import {
  convertJSONToUserAccountId,
  type UserAccountId,
} from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

type UserAccountSnapshotData = {
  id: { value: string };
  name: string;
  sequenceNumber: number;
  version: number;
};

export type UserAccount = {
  typeName: "UserAccount";
  id: UserAccountId;
  name: string;
  sequenceNumber: number;
  version: number;
  withVersion(version: number): UserAccount;
  updateVersion(version: (value: number) => number): UserAccount;
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
    const createdName = requireUserAccountName(name);
    const created = createUserAccount(id, createdName, 1, 1);
    return [
      created,
      UserAccountCreated.create({
        id: ulid(),
        aggregateId: id,
        name: createdName,
        sequenceNumber: created.sequenceNumber,
        occurredAt: new Date(),
      }),
    ];
  }

  export function replay(
    events: readonly UserAccountEvent[],
    snapshot: UserAccount,
  ): UserAccount {
    return events.reduce(
      (account, event) => applyEvent(account, event, account.version + 1),
      snapshot,
    );
  }

  export function replayFromEvents(
    events: readonly UserAccountEvent[],
  ): UserAccount | undefined {
    const [firstEvent, ...remainingEvents] = events;
    if (firstEvent === undefined) {
      return undefined;
    }
    if (firstEvent.typeName !== "UserAccountCreated") {
      throw new Error("UserAccount history must start with UserAccountCreated");
    }
    if (firstEvent.sequenceNumber !== 1) {
      throw new Error("UserAccount history must start with sequence number 1");
    }
    const initial = createUserAccount(
      firstEvent.aggregateId,
      firstEvent.name,
      firstEvent.sequenceNumber,
      1,
    );
    return remainingEvents.reduce(
      (account, event) => applyEvent(account, event, account.version + 1),
      initial,
    );
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
    withVersion: (newVersion: number) =>
      createUserAccount(id, name, sequenceNumber, newVersion),
    updateVersion: (update: (value: number) => number) =>
      createUserAccount(id, name, sequenceNumber, update(version)),
    rename: (newName: string): [UserAccount, UserAccountEvent] => {
      const renamedName = requireUserAccountName(newName);
      const renamed = createUserAccount(
        id,
        renamedName,
        sequenceNumber + 1,
        version,
      );
      return [
        renamed,
        UserAccountRenamed.create({
          id: ulid(),
          aggregateId: id,
          name: renamedName,
          sequenceNumber: renamed.sequenceNumber,
          occurredAt: new Date(),
        }),
      ];
    },
  });
}

function applyEvent(
  account: UserAccount,
  event: UserAccountEvent,
  version: number,
): UserAccount {
  switch (event.typeName) {
    case "UserAccountRenamed":
      return createUserAccount(
        account.id,
        event.name,
        event.sequenceNumber,
        version,
      );
    case "UserAccountCreated":
      return account;
    default: {
      const exhaustiveCheck: never = event;
      throw new Error(`Unexpected event type: ${exhaustiveCheck}`);
    }
  }
}

function convertJSONToUserAccount(json: unknown): UserAccount {
  const payload = parseSnapshotPayload(json);
  return createUserAccount(
    convertJSONToUserAccountId(payload.data.id),
    payload.data.name,
    payload.data.sequenceNumber,
    payload.data.version,
  );
}

function parseSnapshotPayload(json: unknown): {
  data: UserAccountSnapshotData;
} {
  if (
    typeof json !== "object" ||
    json === null ||
    !("data" in json) ||
    !isSnapshotData(json.data)
  ) {
    throw new Error("Invalid UserAccount JSON");
  }
  return {
    data: json.data,
  };
}

function isSnapshotData(json: unknown): json is UserAccountSnapshotData {
  return (
    typeof json === "object" &&
    json !== null &&
    "id" in json &&
    typeof json.id === "object" &&
    json.id !== null &&
    "value" in json.id &&
    typeof json.id.value === "string" &&
    json.id.value.length > 0 &&
    "name" in json &&
    typeof json.name === "string" &&
    json.name.length > 0 &&
    "sequenceNumber" in json &&
    typeof json.sequenceNumber === "number" &&
    Number.isSafeInteger(json.sequenceNumber) &&
    json.sequenceNumber > 0 &&
    "version" in json &&
    typeof json.version === "number" &&
    Number.isSafeInteger(json.version) &&
    json.version > 0
  );
}

function requireUserAccountName(name: string): string {
  if (name.length === 0) {
    throw new Error("UserAccount name must not be empty");
  }
  return name;
}

export { convertJSONToUserAccount };
