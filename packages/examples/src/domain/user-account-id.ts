import { AggregateId } from "event-store-adapter-js";

const USER_ACCOUNT_ID_BRAND: unique symbol = Symbol("UserAccountId");

export type UserAccountId = AggregateId & Readonly<{
  typeName: "UserAccount";
  [USER_ACCOUNT_ID_BRAND]: true;
}>;

export namespace UserAccountId {
  export function create(value: string): UserAccountId {
    if (typeof value !== "string" || value.length === 0) throw new Error("UserAccountId must not be empty");
    const built = AggregateId.of("UserAccount", value);
    if (built.type === "err") throw built.error;
    return Object.freeze({ ...built.value, typeName: "UserAccount", [USER_ACCOUNT_ID_BRAND]: true as const });
  }
  export function is(value: unknown): value is UserAccountId {
    return typeof value === "object" && value !== null &&
      (value as Partial<UserAccountId>)[USER_ACCOUNT_ID_BRAND] === true;
  }
  export function toJSON(id: UserAccountId): { typeName: "UserAccount"; value: string } {
    if (!is(id)) throw new Error("UserAccountId must be a branded value");
    return { typeName: id.typeName, value: id.value };
  }
  export function fromJSON(value: unknown): UserAccountId {
    if (typeof value !== "object" || value === null || !("typeName" in value) ||
      value.typeName !== "UserAccount" || !("value" in value) || typeof value.value !== "string")
      throw new Error("Invalid UserAccountId JSON");
    return create(value.value);
  }
}
Object.freeze(UserAccountId);
