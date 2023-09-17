import { AggregateId } from "../../types";

class UserAccountId implements AggregateId {
  public readonly typeName = "user-account";
  constructor(public readonly value: string) {}

  get asString(): string {
    return `${this.typeName}-${this.value}`;
  }
  public static fromJSON(jsonString: string): UserAccountId {
    const obj = JSON.parse(jsonString);
    return new UserAccountId(obj.value);
  }
}

export { UserAccountId };
