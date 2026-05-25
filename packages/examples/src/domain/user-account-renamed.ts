import type { Event } from "event-store-adapter-js";
import { UserAccountId } from "./user-account-id";

const USER_ACCOUNT_RENAMED_BRAND: unique symbol = Symbol(
  "UserAccountRenamed",
);
const ISO_UTC_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type UserAccountRenamedDataJson = {
  typeName: "UserAccountRenamed";
  isCreated: false;
  id: string;
  aggregateId: ReturnType<typeof UserAccountId.toJSON>;
  name: string;
  sequenceNumber: number;
  occurredAt: string;
};

type UserAccountRenamedJson =
  | UserAccountRenamedDataJson
  | {
      type: "UserAccountRenamed";
      data: UserAccountRenamedDataJson;
    };

export type UserAccountRenamed = Event<UserAccountId> & {
  typeName: "UserAccountRenamed";
  isCreated: false;
  name: string;
  readonly [USER_ACCOUNT_RENAMED_BRAND]: true;
};

export namespace UserAccountRenamed {
  export function create(input: {
    id: string;
    aggregateId: UserAccountId;
    name: string;
    sequenceNumber: number;
    occurredAt: Date;
  }): UserAccountRenamed {
    requireAggregateId("UserAccountRenamed aggregateId", input.aggregateId);
    requireNonEmptyString("UserAccountRenamed id", input.id);
    requireNonEmptyString("UserAccountRenamed name", input.name);
    requireSequenceNumber("UserAccountRenamed sequenceNumber", input.sequenceNumber);
    requireValidDate("UserAccountRenamed occurredAt", input.occurredAt);
    return Object.freeze({
      [USER_ACCOUNT_RENAMED_BRAND]: true as const,
      ...input,
      typeName: "UserAccountRenamed",
      isCreated: false,
    });
  }

  export function is(value: unknown): value is UserAccountRenamed {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Partial<UserAccountRenamed>;
    return (
      candidate[USER_ACCOUNT_RENAMED_BRAND] === true &&
      candidate.typeName === "UserAccountRenamed" &&
      candidate.isCreated === false &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      UserAccountId.is(candidate.aggregateId) &&
      typeof candidate.name === "string" &&
      candidate.name.length > 0 &&
      isNonNegativeSafeInteger(candidate.sequenceNumber) &&
      isValidDate(candidate.occurredAt)
    );
  }

  export function toJSON(
    value: UserAccountRenamed,
  ): Extract<UserAccountRenamedJson, { type: "UserAccountRenamed" }> {
    if (!is(value)) {
      throw new Error("UserAccountRenamed must be a branded value");
    }
    return {
      type: "UserAccountRenamed",
      data: toDataJson(value),
    };
  }

  export function fromJSON(json: unknown): UserAccountRenamed {
    const data = parseJson(json);
    return create({
      id: data.id,
      aggregateId: UserAccountId.fromJSON(data.aggregateId),
      name: data.name,
      sequenceNumber: data.sequenceNumber,
      occurredAt: new Date(data.occurredAt),
    });
  }
}

Object.freeze(UserAccountRenamed);

function toDataJson(value: UserAccountRenamed): UserAccountRenamedDataJson {
  return {
    typeName: value.typeName,
    isCreated: value.isCreated,
    id: value.id,
    aggregateId: UserAccountId.toJSON(value.aggregateId),
    name: value.name,
    sequenceNumber: value.sequenceNumber,
    occurredAt: value.occurredAt.toISOString(),
  };
}

function parseJson(json: unknown): UserAccountRenamedDataJson {
  if (isUserAccountRenamedDataJson(json)) {
    return json;
  }
  if (
    typeof json === "object" &&
    json !== null &&
    "type" in json &&
    json.type === "UserAccountRenamed" &&
    "data" in json &&
    isUserAccountRenamedDataJson(json.data)
  ) {
    return json.data;
  }
  throw new Error("Invalid UserAccountRenamed JSON");
}

function isUserAccountRenamedDataJson(
  json: unknown,
): json is UserAccountRenamedDataJson {
  return (
    typeof json === "object" &&
    json !== null &&
    "typeName" in json &&
    json.typeName === "UserAccountRenamed" &&
    "isCreated" in json &&
    json.isCreated === false &&
    "id" in json &&
    typeof json.id === "string" &&
    json.id.length > 0 &&
    "aggregateId" in json &&
    isUserAccountIdJson(json.aggregateId) &&
    "name" in json &&
    typeof json.name === "string" &&
    json.name.length > 0 &&
    "sequenceNumber" in json &&
    isPositiveSafeInteger(json.sequenceNumber) &&
    "occurredAt" in json &&
    isIsoUtcDateTime(json.occurredAt)
  );
}

function isUserAccountIdJson(
  json: unknown,
): json is ReturnType<typeof UserAccountId.toJSON> {
  return (
    typeof json === "object" &&
    json !== null &&
    "typeName" in json &&
    json.typeName === "user-account" &&
    "value" in json &&
    typeof json.value === "string" &&
    json.value.length > 0
  );
}

function requireAggregateId(fieldName: string, value: unknown): void {
  if (!UserAccountId.is(value)) {
    throw new Error(`${fieldName} must be a branded UserAccountId`);
  }
}

function requireNonEmptyString(fieldName: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

function requireSequenceNumber(fieldName: string, value: unknown): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function requireValidDate(fieldName: string, value: unknown): void {
  if (!isValidDate(value)) {
    throw new Error(`${fieldName} must be a valid Date`);
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isIsoUtcDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_UTC_DATE_TIME_PATTERN.test(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}
