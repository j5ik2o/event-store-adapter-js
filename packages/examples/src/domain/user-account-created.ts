const BRAND: unique symbol = Symbol("UserAccountCreated");

export type UserAccountCreated = Readonly<{
  typeName: "UserAccountCreated";
  id: string;
  name: string;
  [BRAND]: true;
}>;

export namespace UserAccountCreated {
  export function create(input: { id: string; name: string }): UserAccountCreated {
    if (typeof input.id !== "string" || input.id.length === 0 ||
      typeof input.name !== "string" || input.name.length === 0) throw new Error("Invalid UserAccountCreated");
    return Object.freeze({ [BRAND]: true as const, typeName: "UserAccountCreated", ...input });
  }
  export function is(value: unknown): value is UserAccountCreated {
    return typeof value === "object" && value !== null && (value as Partial<UserAccountCreated>)[BRAND] === true;
  }
  export function toJSON(value: UserAccountCreated) {
    if (!is(value)) throw new Error("UserAccountCreated must be branded");
    return { type: value.typeName, data: { id: value.id, name: value.name } };
  }
  export function fromJSON(json: unknown): UserAccountCreated {
    if (typeof json !== "object" || json === null || !("type" in json) ||
      json.type !== "UserAccountCreated" || !("data" in json) || typeof json.data !== "object" ||
      json.data === null || !("id" in json.data) || typeof json.data.id !== "string" ||
      !("name" in json.data) || typeof json.data.name !== "string") throw new Error("Invalid UserAccountCreated JSON");
    return create({ id: json.data.id, name: json.data.name });
  }
}
Object.freeze(UserAccountCreated);
