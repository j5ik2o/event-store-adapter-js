import { UserAccountCreated } from "./user-account-created";
import { UserAccountRenamed } from "./user-account-renamed";

type UserAccountEvent = UserAccountCreated | UserAccountRenamed;

function isUserAccountEvent(value: unknown): value is UserAccountEvent {
  return UserAccountCreated.is(value) || UserAccountRenamed.is(value);
}

function toUserAccountEventJSON(value: UserAccountEvent) {
  switch (value.typeName) {
    case "UserAccountCreated":
      return UserAccountCreated.toJSON(value);
    case "UserAccountRenamed":
      return UserAccountRenamed.toJSON(value);
    default: {
      const exhaustiveCheck: never = value;
      throw new Error(`Unknown UserAccountEvent type: ${exhaustiveCheck}`);
    }
  }
}

function userAccountEventFromJSON(json: unknown): UserAccountEvent {
  if (typeof json !== "object" || json === null || !("type" in json)) {
    if (
      typeof json === "object" &&
      json !== null &&
      "typeName" in json &&
      json.typeName === "UserAccountCreated"
    ) {
      return UserAccountCreated.fromJSON(json);
    }
    if (
      typeof json === "object" &&
      json !== null &&
      "typeName" in json &&
      json.typeName === "UserAccountRenamed"
    ) {
      return UserAccountRenamed.fromJSON(json);
    }
    throw new Error("Invalid UserAccountEvent JSON");
  }
  switch (json.type) {
    case "UserAccountCreated":
      return UserAccountCreated.fromJSON(json);
    case "UserAccountRenamed":
      return UserAccountRenamed.fromJSON(json);
    default:
      throw new Error("Invalid UserAccountEvent JSON");
  }
}

const UserAccountEvent = Object.freeze({
  is: isUserAccountEvent,
  toJSON: toUserAccountEventJSON,
  fromJSON: userAccountEventFromJSON,
});

const convertJSONToUserAccountEvent = UserAccountEvent.fromJSON;

export { convertJSONToUserAccountEvent, UserAccountEvent };
