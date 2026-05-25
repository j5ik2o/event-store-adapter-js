import type { AggregateId } from "../../types";

const USER_ACCOUNT_ID_BRAND: unique symbol = Symbol("UserAccountId");

type UserAccountIdJson = {
  typeName: "user-account";
  value: string;
};

export type UserAccountId = AggregateId & {
  typeName: "user-account";
  readonly [USER_ACCOUNT_ID_BRAND]: true;
};

export namespace UserAccountId {
  export function create(value: string): UserAccountId {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("UserAccountId value must be a non-empty string");
    }
    return Object.freeze({
      [USER_ACCOUNT_ID_BRAND]: true as const,
      typeName: "user-account",
      value,
      asString: () => `user-account-${value}`,
    });
  }

  export function is(value: unknown): value is UserAccountId {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Partial<UserAccountId>;
    return (
      candidate[USER_ACCOUNT_ID_BRAND] === true &&
      candidate.typeName === "user-account" &&
      typeof candidate.value === "string" &&
      candidate.value.length > 0 &&
      typeof candidate.asString === "function"
    );
  }

  export function toJSON(value: UserAccountId): UserAccountIdJson {
    if (!is(value)) {
      throw new Error("UserAccountId must be a branded value");
    }
    return {
      typeName: value.typeName,
      value: value.value,
    };
  }

  export function fromJSON(json: unknown): UserAccountId {
    if (!isUserAccountIdJson(json)) {
      throw new Error("Invalid UserAccountId JSON");
    }
    return create(json.value);
  }
}

Object.freeze(UserAccountId);

const convertJSONToUserAccountId = UserAccountId.fromJSON;

function isUserAccountIdJson(json: unknown): json is UserAccountIdJson {
  return (
    typeof json === "object" &&
    json !== null &&
    "typeName" in json &&
    json.typeName === "user-account" &&
    "value" in json &&
    typeof json.value === "string"
  );
}

export { convertJSONToUserAccountId };
