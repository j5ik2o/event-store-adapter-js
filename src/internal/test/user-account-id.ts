import type { AggregateId } from "../../types";

class UserAccountId implements AggregateId {
  public readonly typeName = "user-account";
  constructor(public readonly value: string) {}

  asString(): string {
    return `${this.typeName}-${this.value}`;
  }
}

// biome-ignore lint/suspicious/noExplicitAny:
function convertJSONToUserAccountId(json: any): UserAccountId {
  return new UserAccountId(json.value);
}

export { UserAccountId, convertJSONToUserAccountId };
