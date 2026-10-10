import { ulid } from "ulid";
import { UserAccountCreated } from "./user-account-created";
import type { UserAccountEvent } from "./user-account-event";
import { UserAccountId } from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

const USER_ACCOUNT_BRAND: unique symbol = Symbol("UserAccount");

export type UserAccount = Readonly<{
  id: UserAccountId;
  name: string;
  rename(name: string): [UserAccount, UserAccountEvent];
  [USER_ACCOUNT_BRAND]: true;
}>;

export namespace UserAccount {
  export function createSnapshot(id: UserAccountId, name: string): UserAccount {
    if (!UserAccountId.is(id)) throw new Error("UserAccount id must be branded");
    if (typeof name !== "string" || name.length === 0) throw new Error("UserAccount name must not be empty");
    return Object.freeze({
      [USER_ACCOUNT_BRAND]: true as const, id, name,
      rename: (newName: string): [UserAccount, UserAccountEvent] => [
        createSnapshot(id, newName), UserAccountRenamed.create({ id: ulid(), name: newName }),
      ],
    });
  }
  export function create(id: UserAccountId, name: string): [UserAccount, UserAccountEvent] {
    return [createSnapshot(id, name), UserAccountCreated.create({ id: ulid(), name })];
  }
  export function replay(events: readonly UserAccountEvent[], snapshot: UserAccount): UserAccount {
    return events.reduce((account, event) => {
      if (event.typeName !== "UserAccountRenamed") throw new Error("An existing account cannot be created again");
      return createSnapshot(account.id, event.name);
    }, snapshot);
  }
  export function replayFromEvents(id: UserAccountId, events: readonly UserAccountEvent[]): UserAccount | undefined {
    const [first, ...remaining] = events;
    if (first === undefined) return undefined;
    if (first.typeName !== "UserAccountCreated") throw new Error("UserAccount history must start with UserAccountCreated");
    return replay(remaining, createSnapshot(id, first.name));
  }
  export function is(value: unknown): value is UserAccount {
    return typeof value === "object" && value !== null &&
      (value as Partial<UserAccount>)[USER_ACCOUNT_BRAND] === true;
  }
  export function toJSON(value: UserAccount) {
    if (!is(value)) throw new Error("UserAccount must be branded");
    return { type: "UserAccount", data: { id: UserAccountId.toJSON(value.id), name: value.name } };
  }
  export function fromJSON(json: unknown): UserAccount {
    if (typeof json !== "object" || json === null || !("type" in json) ||
      json.type !== "UserAccount" || !("data" in json) || typeof json.data !== "object" ||
      json.data === null || !("id" in json.data) || !("name" in json.data) || typeof json.data.name !== "string")
      throw new Error("Invalid UserAccount JSON");
    return createSnapshot(UserAccountId.fromJSON(json.data.id), json.data.name);
  }
}
Object.freeze(UserAccount);
