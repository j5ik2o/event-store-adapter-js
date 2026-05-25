import type { Event } from "event-store-adapter-js";
import { UserAccountId } from "./user-account-id";

const USER_ACCOUNT_CREATED_BRAND: unique symbol = Symbol(
  "UserAccountCreated",
);
const ISO_UTC_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type UserAccountCreatedDataJson = {
  typeName: "UserAccountCreated";
  isCreated: true;
  id: string;
  aggregateId: ReturnType<typeof UserAccountId.toJSON>;
  name: string;
  sequenceNumber: number;
  occurredAt: string;
};

type UserAccountCreatedJson =
  | UserAccountCreatedDataJson
  | {
      type: "UserAccountCreated";
      data: UserAccountCreatedDataJson;
    };

export type UserAccountCreated = Event<UserAccountId> & {
  typeName: "UserAccountCreated";
  isCreated: true;
  name: string;
  readonly [USER_ACCOUNT_CREATED_BRAND]: true;
};

export namespace UserAccountCreated {
  export function create(input: {
    id: string;
    aggregateId: UserAccountId;
    name: string;
    sequenceNumber: number;
    occurredAt: Date;
  }): UserAccountCreated {
    requireAggregateId("UserAccountCreated aggregateId", input.aggregateId);
    requireNonEmptyString("UserAccountCreated id", input.id);
    requireNonEmptyString("UserAccountCreated name", input.name);
    requireSequenceNumber("UserAccountCreated sequenceNumber", input.sequenceNumber);
    requireValidDate("UserAccountCreated occurredAt", input.occurredAt);
    return Object.freeze({
      [USER_ACCOUNT_CREATED_BRAND]: true as const,
      ...input,
      typeName: "UserAccountCreated",
      isCreated: true,
    });
  }

  export function is(value: unknown): value is UserAccountCreated {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Partial<UserAccountCreated>;
    return (
      candidate[USER_ACCOUNT_CREATED_BRAND] === true &&
      candidate.typeName === "UserAccountCreated" &&
      candidate.isCreated === true &&
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
    value: UserAccountCreated,
  ): Extract<UserAccountCreatedJson, { type: "UserAccountCreated" }> {
    if (!is(value)) {
      throw new Error("UserAccountCreated must be a branded value");
    }
    return {
      type: "UserAccountCreated",
      data: toDataJson(value),
    };
  }

  export function fromJSON(json: unknown): UserAccountCreated {
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

Object.freeze(UserAccountCreated);

function toDataJson(value: UserAccountCreated): UserAccountCreatedDataJson {
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

function parseJson(json: unknown): UserAccountCreatedDataJson {
  if (isUserAccountCreatedDataJson(json)) {
    return json;
  }
  if (
    typeof json === "object" &&
    json !== null &&
    "type" in json &&
    json.type === "UserAccountCreated" &&
    "data" in json &&
    isUserAccountCreatedDataJson(json.data)
  ) {
    return json.data;
  }
  throw new Error("Invalid UserAccountCreated JSON");
}

function isUserAccountCreatedDataJson(
  json: unknown,
): json is UserAccountCreatedDataJson {
  return (
    typeof json === "object" &&
    json !== null &&
    "typeName" in json &&
    json.typeName === "UserAccountCreated" &&
    "isCreated" in json &&
    json.isCreated === true &&
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
