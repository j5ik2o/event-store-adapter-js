import type { AggregateId } from "event-store-adapter-js";

export type UserAccountId = AggregateId & {
  typeName: "user-account";
};

export namespace UserAccountId {
  export function create(value: string): UserAccountId {
    if (value.length === 0) {
      throw new Error("UserAccountId value must not be empty");
    }
    return Object.freeze({
      typeName: "user-account",
      value,
      asString: () => `user-account-${value}`,
    });
  }
}

Object.freeze(UserAccountId);

function convertJSONToUserAccountId(json: unknown): UserAccountId {
  if (!isUserAccountIdJson(json)) {
    throw new Error("Invalid UserAccountId JSON");
  }
  return UserAccountId.create(json.value);
}

function isUserAccountIdJson(json: unknown): json is { value: string } {
  return (
    typeof json === "object" &&
    json !== null &&
    "value" in json &&
    typeof json.value === "string"
  );
}

export { convertJSONToUserAccountId };
