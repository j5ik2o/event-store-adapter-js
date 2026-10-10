import { UserAccountCreated } from "./user-account-created";
import { UserAccountRenamed } from "./user-account-renamed";

export type UserAccountEvent = UserAccountCreated | UserAccountRenamed;

export namespace UserAccountEvent {
  export function is(value: unknown): value is UserAccountEvent {
    return UserAccountCreated.is(value) || UserAccountRenamed.is(value);
  }
  export function toJSON(value: UserAccountEvent) {
    switch (value.typeName) {
      case "UserAccountCreated": return UserAccountCreated.toJSON(value);
      case "UserAccountRenamed": return UserAccountRenamed.toJSON(value);
    }
  }
  export function fromJSON(json: unknown): UserAccountEvent {
    if (typeof json !== "object" || json === null || !("type" in json)) throw new Error("Invalid UserAccountEvent JSON");
    switch (json.type) {
      case "UserAccountCreated": return UserAccountCreated.fromJSON(json);
      case "UserAccountRenamed": return UserAccountRenamed.fromJSON(json);
      default: throw new Error("Unknown UserAccountEvent type");
    }
  }
}
Object.freeze(UserAccountEvent);
