import { AggregateId } from "../../types";

class UserAccountId implements AggregateId {
  public readonly typeName = "user-account";
  constructor(public readonly value: string) {}

  asString(): string {
    return `${this.typeName}-${this.value}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertJSONToUserAccountId(json: any): UserAccountId {
  return new UserAccountId(json.value);
}

export { UserAccountId, convertJSONToUserAccountId };
