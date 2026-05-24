import type { Event } from "../../types";
import type { UserAccountId } from "./user-account-id";

export type UserAccountRenamed = Event<UserAccountId> & {
  typeName: "UserAccountRenamed";
  isCreated: false;
  name: string;
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
    requireSequenceNumber(
      "UserAccountRenamed sequenceNumber",
      input.sequenceNumber,
    );
    requireValidDate("UserAccountRenamed occurredAt", input.occurredAt);
    return Object.freeze({
      ...input,
      typeName: "UserAccountRenamed",
      isCreated: false,
    });
  }
}

Object.freeze(UserAccountRenamed);

function requireAggregateId(fieldName: string, value: UserAccountId): void {
  if (value === undefined || value === null) {
    throw new Error(`${fieldName} must not be undefined or null`);
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
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${fieldName} must be a valid Date`);
  }
}
