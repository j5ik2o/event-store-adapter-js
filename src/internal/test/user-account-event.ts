import { Event } from "../../types";
import { UserAccountId } from "./user-account-id";

interface UserAccountEvent extends Event<UserAccountId> {}

function fromJSON(jsonString: string): UserAccountEvent {
  const obj = JSON.parse(jsonString);
  switch (obj.type) {
    case "UserAccountCreated":
      return new UserAccountCreated(
        obj.id,
        obj.name,
        obj.sequenceNumber,
        obj.version,
      );
    case "UserAccountRenamed":
      return new UserAccountRenamed(
        obj.id,
        obj.name,
        obj.sequenceNumber,
        obj.version,
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
    public readonly sequenceNumber: number,
    public readonly occurredAt: Date,
  ) {}
}

class UserAccountRenamed implements UserAccountEvent {
  public readonly isCreated: boolean = false;
  constructor(
    public readonly id: string,
    public readonly aggregateId: UserAccountId,
    public readonly sequenceNumber: number,
    public readonly occurredAt: Date,
  ) {}
}

export { UserAccountEvent, UserAccountCreated, UserAccountRenamed };
