import type { Aggregate } from "event-store-adapter-js";
import { ulid } from "ulid";
import { UserAccountCreated } from "./user-account-created";
import type { UserAccountEvent } from "./user-account-event";
import {
  convertJSONToUserAccountId,
  type UserAccountId,
} from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

type UserAccountSnapshotData = {
  id: { value: string };
  name: string;
  sequenceNumber: number;
  version: number;
};

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
    const renamedName = requireUserAccountName(name);
    const renamed = new UserAccount(
      this.id,
      renamedName,
      this.sequenceNumber + 1,
      this.version,
    );
    return [
      renamed,
      new UserAccountRenamed(
        ulid(),
        this.id,
        renamedName,
        renamed.sequenceNumber,
        new Date(),
      ),
    ];
  }

  static create(
    id: UserAccountId,
    name: string,
  ): [UserAccount, UserAccountEvent] {
    const createdName = requireUserAccountName(name);
    const created = new UserAccount(id, createdName, 1, 1);
    return [
      created,
      new UserAccountCreated(
        ulid(),
        id,
        createdName,
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
      (account, event) => account.applySnapshotEvent(event),
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
    return remainingEvents.reduce(
      (account, event) => account.applyStoredEvent(event),
      initial,
    );
  }

  private applySnapshotEvent(event: UserAccountEvent): UserAccount {
    return this.applyEvent(event, this.version);
  }

  private applyStoredEvent(event: UserAccountEvent): UserAccount {
    return this.applyEvent(event, this.version + 1);
  }

  private applyEvent(event: UserAccountEvent, version: number): UserAccount {
    if (event instanceof UserAccountRenamed) {
      return new UserAccount(
        this.id,
        event.name,
        event.sequenceNumber,
        version,
      );
    }
    if (event instanceof UserAccountCreated) {
      return this;
    }
    const exhaustiveCheck: never = event;
    throw new Error(`Unexpected event type: ${exhaustiveCheck}`);
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
  data: UserAccountSnapshotData;
} {
  if (
    typeof json !== "object" ||
    json === null ||
    !("data" in json) ||
    !isSnapshotData(json.data)
  ) {
    throw new Error("Invalid UserAccount JSON");
  }
  const data: UserAccountSnapshotData = json.data;
  return {
    data,
  };
}

function isSnapshotData(json: unknown): json is UserAccountSnapshotData {
  return (
    typeof json === "object" &&
    json !== null &&
    "id" in json &&
    typeof json.id === "object" &&
    json.id !== null &&
    "value" in json.id &&
    typeof json.id.value === "string" &&
    json.id.value.length > 0 &&
    "name" in json &&
    typeof json.name === "string" &&
    json.name.length > 0 &&
    "sequenceNumber" in json &&
    typeof json.sequenceNumber === "number" &&
    Number.isSafeInteger(json.sequenceNumber) &&
    json.sequenceNumber > 0 &&
    "version" in json &&
    typeof json.version === "number" &&
    Number.isSafeInteger(json.version) &&
    json.version > 0
  );
}

function requireUserAccountName(name: string): string {
  if (name.length === 0) {
    throw new Error("UserAccount name must not be empty");
  }
  return name;
}

export { convertJSONToUserAccount, UserAccount };
