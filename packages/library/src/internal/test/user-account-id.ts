import {
  type AggregateId,
  type AggregateIdValue,
  createAggregateIdValue,
} from "../../types";

class UserAccountId implements AggregateId {
  public readonly typeName = "user-account";
  public readonly value: AggregateIdValue;

  constructor(value: string) {
    this.value = createAggregateIdValue(value);
  }

  asString(): string {
    return `${this.typeName}-${this.value}`;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: JSON deserialization requires dynamic typing
function convertJSONToUserAccountId(json: any): UserAccountId {
  return new UserAccountId(json.value);
}

export { convertJSONToUserAccountId, UserAccountId };
