import { ulid } from "ulid";
import type { Aggregate } from "../../types";
import {
  UserAccountCreated,
  type UserAccountEvent,
  UserAccountRenamed,
} from "./user-account-event";
import {
  type UserAccountId,
  convertJSONToUserAccountId,
} from "./user-account-id";

class UserAccount implements Aggregate<UserAccount, UserAccountId> {
  public readonly typeName: string = "UserAccount";
  constructor(
    public readonly id: UserAccountId,
    public readonly name: string,
    public readonly sequenceNumber: number,
    public readonly version: number,
  ) {}

  incrementSequenceNumber(): UserAccount {
    return new UserAccount(
      this.id,
      this.name,
      this.sequenceNumber + 1,
      this.version,
    );
  }

  withVersion(version: number): UserAccount {
    return new UserAccount(this.id, this.name, this.sequenceNumber, version);
  }

  updateVersion(version: (value: number) => number): UserAccount {
    return new UserAccount(
      this.id,
      this.name,
      this.sequenceNumber,
      version(this.version),
    );
  }

  rename(name: string): [UserAccount, UserAccountEvent] {
    const ua = new UserAccount(
      this.id,
      name,
      this.sequenceNumber + 1,
      this.version,
    );
    const eventId = ulid();
    const event = new UserAccountRenamed(
      eventId,
      this.id,
      name,
      ua.sequenceNumber,
      new Date(),
    );
    return [ua, event];
  }

  public static create(
    id: UserAccountId,
    name: string,
  ): [UserAccount, UserAccountEvent] {
    const ua = new UserAccount(id, name, 0, 1).incrementSequenceNumber();
    const eventId = ulid();
    const event = new UserAccountCreated(
      eventId,
      id,
      name,
      ua.sequenceNumber,
      new Date(),
    );
    return [ua, event];
  }

  public static replay(
    events: UserAccountEvent[],
    snapshot: UserAccount,
  ): UserAccount {
    let acc = snapshot;
    for (const event of events) {
      acc = acc.applyEvent(event);
    }
    return acc;
  }

  private applyEvent(event: UserAccountEvent): UserAccount {
    if (event instanceof UserAccountRenamed) {
      const [result] = this.rename(event.name);
      return result;
    }
    throw new Error("Unknown event type");
  }
}

// biome-ignore lint/suspicious/noExplicitAny:
function convertJSONToUserAccount(json: any): UserAccount {
  const id = convertJSONToUserAccountId(json.data.id);
  return new UserAccount(
    id,
    json.data.name,
    json.data.sequenceNumber,
    json.data.version,
  );
}

export { UserAccount, convertJSONToUserAccount };
