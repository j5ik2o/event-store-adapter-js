import { Event } from "../../types";
import { convertJSONToUserAccountId, UserAccountId } from "./user-account-id";

interface UserAccountEvent extends Event<UserAccountId> {}

class UserAccountCreated implements UserAccountEvent {
  public readonly typeName: string = "UserAccountCreated";
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
  public readonly typeName: string = "UserAccountRenamed";
  public readonly isCreated: boolean = false;
  constructor(
    public readonly id: string,
    public readonly aggregateId: UserAccountId,
    public readonly name: string,
    public readonly sequenceNumber: number,
    public readonly occurredAt: Date,
  ) {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertJSONtoUserAccountEvent(json: any): UserAccountEvent {
  const aggregateId = convertJSONToUserAccountId(json.data.aggregateId);
  switch (json.type) {
    case "UserAccountCreated":
      return new UserAccountCreated(
        json.data.id,
        aggregateId,
        json.data.name,
        json.data.sequenceNumber,
        json.data.occurredAt,
      );
    case "UserAccountRenamed":
      return new UserAccountRenamed(
        json.data.id,
        aggregateId,
        json.data.name,
        json.data.sequenceNumber,
        json.data.occurredAt,
      );
    default:
      throw new Error(`Unknown type: ${json.type}`);
  }
}

export {
  UserAccountEvent,
  UserAccountCreated,
  UserAccountRenamed,
  convertJSONtoUserAccountEvent,
};
