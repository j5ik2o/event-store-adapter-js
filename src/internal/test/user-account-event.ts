import { Event } from "../../types";
import { convertJSONToUserAccountId, UserAccountId } from "./user-account-id";

interface UserAccountEvent extends Event<UserAccountId> {}

function convertJSONtoUserAccountEvent(jsonString: string): UserAccountEvent {
  const obj = JSON.parse(jsonString);
  const aggregateId = convertJSONToUserAccountId(
    JSON.stringify(obj.data.aggregateId),
  );
  switch (obj.type) {
    case "UserAccountCreated":
      return new UserAccountCreated(
        obj.data.id,
        aggregateId,
        obj.data.name,
        obj.data.sequenceNumber,
        obj.data.occurredAt,
      );
    case "UserAccountRenamed":
      return new UserAccountRenamed(
        obj.data.id,
        aggregateId,
        obj.data.name,
        obj.data.sequenceNumber,
        obj.data.occurredAt,
      );
    default:
      throw new Error(`Unknown type: ${obj.type}`);
  }
}

class UserAccountCreated implements UserAccountEvent {
  public readonly isCreated: boolean = true;

  constructor(
    public readonly id: string,
    public readonly aggregateId: UserAccountId,
    public readonly name: string,
    public readonly sequenceNumber: number,
    public readonly occurredAt: Date,
  ) {}
}

class UserAccountRenamed implements UserAccountEvent {
  public readonly isCreated: boolean = false;
  constructor(
    public readonly id: string,
    public readonly aggregateId: UserAccountId,
    public readonly name: string,
    public readonly sequenceNumber: number,
    public readonly occurredAt: Date,
  ) {}
}

export {
  UserAccountEvent,
  UserAccountCreated,
  UserAccountRenamed,
  convertJSONtoUserAccountEvent,
};
