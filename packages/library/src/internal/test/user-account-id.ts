import type { AggregateId } from "../../types";

export type UserAccountId = AggregateId & {
  typeName: "user-account";
};

export namespace UserAccountId {
  export function create(value: string): UserAccountId {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("UserAccountId value must be a non-empty string");
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
  if (typeof json !== "object" || json === null || !("value" in json)) {
    throw new Error("Invalid UserAccountId JSON");
  }
  if (typeof json.value !== "string") {
    throw new Error("UserAccountId value must be a non-empty string");
  }
  return UserAccountId.create(json.value);
}

export { convertJSONToUserAccountId };
