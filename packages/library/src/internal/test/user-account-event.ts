import {
  UserAccountCreated,
  type UserAccountCreated as UserAccountCreatedEvent,
} from "./user-account-created";
import { convertJSONToUserAccountId } from "./user-account-id";
import {
  UserAccountRenamed,
  type UserAccountRenamed as UserAccountRenamedEvent,
} from "./user-account-renamed";

type UserAccountEvent = UserAccountCreatedEvent | UserAccountRenamedEvent;

// biome-ignore lint/suspicious/noExplicitAny: JSON deserialization requires dynamic typing
function convertJSONtoUserAccountEvent(json: any): UserAccountEvent {
  const aggregateId = convertJSONToUserAccountId(json.data.aggregateId);
  switch (json.type) {
    case "UserAccountCreated":
      return UserAccountCreated.create({
        id: json.data.id,
        aggregateId,
        name: json.data.name,
        sequenceNumber: json.data.sequenceNumber,
        occurredAt: new Date(json.data.occurredAt),
      });
    case "UserAccountRenamed":
      return UserAccountRenamed.create({
        id: json.data.id,
        aggregateId,
        name: json.data.name,
        sequenceNumber: json.data.sequenceNumber,
        occurredAt: new Date(json.data.occurredAt),
      });
    default:
      throw new Error(`Unknown type: ${json.type}`);
  }
}

export {
  convertJSONtoUserAccountEvent,
  UserAccountCreated,
  type UserAccountEvent,
  UserAccountRenamed,
};
