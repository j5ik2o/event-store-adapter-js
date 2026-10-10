const BRAND: unique symbol = Symbol("UserAccountRenamed");

export type UserAccountRenamed = Readonly<{
  typeName: "UserAccountRenamed";
  id: string;
  name: string;
  [BRAND]: true;
}>;

export namespace UserAccountRenamed {
  export function create(input: { id: string; name: string }): UserAccountRenamed {
    if (typeof input.id !== "string" || input.id.length === 0 ||
      typeof input.name !== "string" || input.name.length === 0) throw new Error("Invalid UserAccountRenamed");
    return Object.freeze({ [BRAND]: true as const, typeName: "UserAccountRenamed", ...input });
  }
  export function is(value: unknown): value is UserAccountRenamed {
    return typeof value === "object" && value !== null && (value as Partial<UserAccountRenamed>)[BRAND] === true;
  }
  export function toJSON(value: UserAccountRenamed) {
    if (!is(value)) throw new Error("UserAccountRenamed must be branded");
    return { type: value.typeName, data: { id: value.id, name: value.name } };
  }
  export function fromJSON(json: unknown): UserAccountRenamed {
    if (typeof json !== "object" || json === null || !("type" in json) ||
      json.type !== "UserAccountRenamed" || !("data" in json) || typeof json.data !== "object" ||
      json.data === null || !("id" in json.data) || typeof json.data.id !== "string" ||
      !("name" in json.data) || typeof json.data.name !== "string") throw new Error("Invalid UserAccountRenamed JSON");
    return create({ id: json.data.id, name: json.data.name });
  }
}
Object.freeze(UserAccountRenamed);
