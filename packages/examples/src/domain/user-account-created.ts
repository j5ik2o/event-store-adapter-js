import type { Event } from "event-store-adapter-js";
import type { UserAccountId } from "./user-account-id";

class UserAccountCreated implements Event<UserAccountId> {
  public readonly typeName = "UserAccountCreated";
  public readonly isCreated = true;

  constructor(
    public readonly id: string,
    public readonly aggregateId: UserAccountId,
    public readonly name: string,
    public readonly sequenceNumber: number,
    public readonly occurredAt: Date,
  ) {}
}

export { UserAccountCreated };
