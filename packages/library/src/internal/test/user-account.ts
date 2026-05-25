import { ulid } from "ulid";
import { UserAccountCreated } from "./user-account-created";
import type { UserAccountEvent } from "./user-account-event";
import { UserAccountId } from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

const USER_ACCOUNT_BRAND: unique symbol = Symbol("UserAccount");

type UserAccountSnapshotData = {
  typeName: "UserAccount";
  id: ReturnType<typeof UserAccountId.toJSON>;
  name: string;
  sequenceNumber: number;
  version: number;
};

type UserAccountJson =
  | UserAccountSnapshotData
  | {
      type: "UserAccount";
      data: UserAccountSnapshotData;
    };

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
  readonly [USER_ACCOUNT_BRAND]: true;
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
    requireUserAccountId("UserAccount id", id);
    const createdName = requireUserAccountName(name);
    const initialUserAccount = createUserAccount(id, createdName, 0, 1);
    const userAccount = initialUserAccount.incrementSequenceNumber();
    const event = UserAccountCreated.create({
      id: ulid(),
      aggregateId: id,
      name: createdName,
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

  export function is(value: unknown): value is UserAccount {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Partial<UserAccount>;
    return (
      candidate[USER_ACCOUNT_BRAND] === true &&
      candidate.typeName === "UserAccount" &&
      UserAccountId.is(candidate.id) &&
      typeof candidate.name === "string" &&
      candidate.name.length > 0 &&
      isNonNegativeSafeInteger(candidate.sequenceNumber) &&
      isPositiveSafeInteger(candidate.version) &&
      typeof candidate.withVersion === "function" &&
      typeof candidate.updateVersion === "function" &&
      typeof candidate.incrementSequenceNumber === "function" &&
      typeof candidate.rename === "function"
    );
  }

  export function toJSON(
    value: UserAccount,
  ): Extract<UserAccountJson, { type: "UserAccount" }> {
    if (!is(value)) {
      throw new Error("UserAccount must be a branded value");
    }
    return {
      type: "UserAccount",
      data: toSnapshotData(value),
    };
  }

  export function fromJSON(json: unknown): UserAccount {
    const data = parseSnapshotData(json);
    return createSnapshot(
      UserAccountId.fromJSON(data.id),
      data.name,
      data.sequenceNumber,
      data.version,
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
  requireUserAccountId("UserAccount id", id);
  requireUserAccountName(name);
  requireSequenceNumber("UserAccount sequenceNumber", sequenceNumber);
  requireVersion("UserAccount version", version);
  return Object.freeze({
    [USER_ACCOUNT_BRAND]: true as const,
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
      const renamedName = requireUserAccountName(newName);
      const userAccount = createUserAccount(
        id,
        renamedName,
        sequenceNumber + 1,
        version,
      );
      const event = UserAccountRenamed.create({
        id: ulid(),
        aggregateId: id,
        name: renamedName,
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

const convertJSONToUserAccount = UserAccount.fromJSON;

function toSnapshotData(value: UserAccount): UserAccountSnapshotData {
  return {
    typeName: value.typeName,
    id: UserAccountId.toJSON(value.id),
    name: value.name,
    sequenceNumber: value.sequenceNumber,
    version: value.version,
  };
}

function parseSnapshotData(json: unknown): UserAccountSnapshotData {
  if (isSnapshotData(json)) {
    return json;
  }
  if (
    typeof json !== "object" ||
    json === null ||
    !("type" in json) ||
    json.type !== "UserAccount" ||
    !("data" in json) ||
    !isSnapshotData(json.data)
  ) {
    throw new Error("Invalid UserAccount JSON");
  }
  return json.data;
}

function isSnapshotData(json: unknown): json is UserAccountSnapshotData {
  return (
    typeof json === "object" &&
    json !== null &&
    "typeName" in json &&
    json.typeName === "UserAccount" &&
    "id" in json &&
    isUserAccountIdJson(json.id) &&
    "name" in json &&
    typeof json.name === "string" &&
    json.name.length > 0 &&
    "sequenceNumber" in json &&
    isNonNegativeSafeInteger(json.sequenceNumber) &&
    "version" in json &&
    isPositiveSafeInteger(json.version)
  );
}

function isUserAccountIdJson(
  json: unknown,
): json is ReturnType<typeof UserAccountId.toJSON> {
  return (
    typeof json === "object" &&
    json !== null &&
    "typeName" in json &&
    json.typeName === "user-account" &&
    "value" in json &&
    typeof json.value === "string" &&
    json.value.length > 0
  );
}

function requireUserAccountId(fieldName: string, value: unknown): void {
  if (!UserAccountId.is(value)) {
    throw new Error(`${fieldName} must be a branded UserAccountId`);
  }
}

function requireUserAccountName(name: string): string {
  if (name.length === 0) {
    throw new Error("UserAccount name must not be empty");
  }
  return name;
}

function requireSequenceNumber(fieldName: string, value: unknown): void {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function requireVersion(fieldName: string, value: unknown): void {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

export { convertJSONToUserAccount };
