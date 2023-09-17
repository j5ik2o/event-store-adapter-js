import { Aggregate } from "../../types";
import { ulid } from "ulid";
import { convertJSONToUserAccountId, UserAccountId } from "./user-account-id";
import {
  UserAccountCreated,
  UserAccountEvent,
  UserAccountRenamed,
} from "./user-account-event";

class UserAccount implements Aggregate<UserAccountId> {
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

  withVersion(version: (value: number) => number): UserAccount {
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
    version: number,
  ): UserAccount {
    console.log("replay = ", version);
    let acc = snapshot;
    for (const event of events) {
      acc = acc.applyEvent(event);
    }
    return acc.withVersion((_) => version);
  }

  public applyEvent(event: UserAccountEvent): UserAccount {
    console.log("applyEvent", event);
    if (event instanceof UserAccountRenamed) {
      const [result] = this.rename(event.name);
      return result;
    } else {
      throw new Error("Unknown event type");
    }
  }
}

function convertJSONToUserAccount(jsonString: string): UserAccount {
  const obj = JSON.parse(jsonString);
  const id = convertJSONToUserAccountId(JSON.stringify(obj.data.id));
  return new UserAccount(
    id,
    obj.data.name,
    obj.data.sequenceNumber,
    obj.data.version,
  );
}

export { UserAccount, convertJSONToUserAccount };
