import {Event} from "../../types";
import {UserAccountId} from "./user-account-id";


interface UserAccountEvent extends Event<UserAccountId> {}

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

export {UserAccountEvent, UserAccountCreated, UserAccountRenamed};
