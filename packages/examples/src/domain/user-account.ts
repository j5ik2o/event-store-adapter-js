import type { Aggregate } from "event-store-adapter-js";
import { ulid } from "ulid";
import { UserAccountCreated } from "./user-account-created";
import type { UserAccountEvent } from "./user-account-event";
import {
  convertJSONToUserAccountId,
  type UserAccountId,
} from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

class UserAccount implements Aggregate<UserAccount, UserAccountId> {
  public readonly typeName = "UserAccount";

  constructor(
    public readonly id: UserAccountId,
    public readonly name: string,
    public readonly sequenceNumber: number,
    public readonly version: number,
  ) {}

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
    const renamed = new UserAccount(
      this.id,
      name,
      this.sequenceNumber + 1,
      this.version,
    );
    return [
      renamed,
      new UserAccountRenamed(
        ulid(),
        this.id,
        name,
        renamed.sequenceNumber,
        new Date(),
      ),
    ];
  }

  static create(
    id: UserAccountId,
    name: string,
  ): [UserAccount, UserAccountEvent] {
    const created = new UserAccount(id, name, 1, 1);
    return [
      created,
      new UserAccountCreated(
        ulid(),
        id,
        name,
        created.sequenceNumber,
        new Date(),
      ),
    ];
  }

  static replay(
    events: readonly UserAccountEvent[],
    snapshot: UserAccount,
  ): UserAccount {
    return events.reduce(
      (account, event) => account.applyEvent(event),
      snapshot,
    );
  }

  static replayFromEvents(
    events: readonly UserAccountEvent[],
  ): UserAccount | undefined {
    const [firstEvent, ...remainingEvents] = events;
    if (firstEvent === undefined) {
      return undefined;
    }
    if (!(firstEvent instanceof UserAccountCreated)) {
      throw new Error("UserAccount history must start with UserAccountCreated");
    }
    const initial = new UserAccount(
      firstEvent.aggregateId,
      firstEvent.name,
      firstEvent.sequenceNumber,
      1,
    );
    return UserAccount.replay(remainingEvents, initial);
  }

  private applyEvent(event: UserAccountEvent): UserAccount {
    if (event instanceof UserAccountRenamed) {
      return new UserAccount(
        this.id,
        event.name,
        event.sequenceNumber,
        this.version,
      );
    }
    return this;
  }
}

function convertJSONToUserAccount(json: unknown): UserAccount {
  const payload = parseSnapshotPayload(json);
  return new UserAccount(
    convertJSONToUserAccountId(payload.data.id),
    payload.data.name,
    payload.data.sequenceNumber,
    payload.data.version,
  );
}

function parseSnapshotPayload(json: unknown): {
  data: {
    id: unknown;
    name: string;
    sequenceNumber: number;
    version: number;
  };
} {
  if (
    typeof json !== "object" ||
    json === null ||
    !("data" in json) ||
    !isSnapshotData(json.data)
  ) {
    throw new Error("Invalid UserAccount JSON");
  }
  return {
    data: json.data,
  };
}

function isSnapshotData(json: unknown): json is {
  id: unknown;
  name: string;
  sequenceNumber: number;
  version: number;
} {
  return (
    typeof json === "object" &&
    json !== null &&
    "id" in json &&
    "name" in json &&
    typeof json.name === "string" &&
    "sequenceNumber" in json &&
    typeof json.sequenceNumber === "number" &&
    "version" in json &&
    typeof json.version === "number"
  );
}

export { convertJSONToUserAccount, UserAccount };
