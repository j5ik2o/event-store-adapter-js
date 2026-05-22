import {
  type AggregateId,
  type AggregateIdValue,
  createAggregateIdValue,
} from "event-store-adapter-js";

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

function convertJSONToUserAccountId(json: unknown): UserAccountId {
  if (!isUserAccountIdJson(json)) {
    throw new Error("Invalid UserAccountId JSON");
  }
  return new UserAccountId(json.value);
}

function isUserAccountIdJson(json: unknown): json is { value: string } {
  return (
    typeof json === "object" &&
    json !== null &&
    "value" in json &&
    typeof json.value === "string"
  );
}

export { convertJSONToUserAccountId, UserAccountId };
