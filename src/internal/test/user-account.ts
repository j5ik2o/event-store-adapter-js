import {Aggregate} from "../../types";
import {ulid} from "ulid";
import {UserAccountId} from "./user-account-id";
import {UserAccountCreated, UserAccountEvent, UserAccountRenamed} from "./user-account-event";

class UserAccount implements Aggregate<UserAccountId> {
    private constructor(
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
            ua.sequenceNumber,
            new Date(),
        );
        return [ua, event];
    }

    public static fromJSON(jsonString: string): UserAccount {
        const obj = JSON.parse(jsonString);
        return new UserAccount(obj.id, obj.name, obj.sequenceNumber, obj.version);
    }

}

export {UserAccount};
