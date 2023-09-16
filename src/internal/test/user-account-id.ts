import {AggregateId} from "../../types";

class UserAccountId implements AggregateId {
    public readonly typeName = "user-account";
    constructor(public readonly value: string) {}

    get asString(): string {
        return `${this.typeName}-${this.value}`;
    }
}

export { UserAccountId };
