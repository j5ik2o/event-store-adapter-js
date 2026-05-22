import type { Event } from "event-store-adapter-js";
import type { UserAccountId } from "./user-account-id";

class UserAccountRenamed implements Event<UserAccountId> {
  public readonly typeName = "UserAccountRenamed";
  public readonly isCreated = false;

  constructor(
    public readonly id: string,
    public readonly aggregateId: UserAccountId,
    public readonly name: string,
    public readonly sequenceNumber: number,
    public readonly occurredAt: Date,
  ) {}
}

export { UserAccountRenamed };
