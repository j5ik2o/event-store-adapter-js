import type { Event } from "../../types";
import type { UserAccountId } from "./user-account-id";

export type UserAccountCreated = Event<UserAccountId> & {
  typeName: "UserAccountCreated";
  isCreated: true;
  name: string;
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
    requireSequenceNumber(
      "UserAccountCreated sequenceNumber",
      input.sequenceNumber,
    );
    requireValidDate("UserAccountCreated occurredAt", input.occurredAt);
    return Object.freeze({
      ...input,
      typeName: "UserAccountCreated",
      isCreated: true,
    });
  }
}

Object.freeze(UserAccountCreated);

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
