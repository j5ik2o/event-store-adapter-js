import { Result } from "../result";
import { EventStoreError } from "./event-store-error";

export type AggregateId = Readonly<{ typeName: string; value: string }>;

const MAX_UTF8_BYTES = 1024;

function check(typeName: string, value: string): EventStoreError | undefined {
  if (typeName.includes("-")) {
    return EventStoreError.contractViolation({
      rule: "T-11",
      detail: "typeName must not contain '-'",
    });
  }
  if (Buffer.byteLength(`${typeName}-${value}`, "utf8") > MAX_UTF8_BYTES) {
    return EventStoreError.contractViolation({
      rule: "T-12",
      detail: `aggregate id must be at most ${MAX_UTF8_BYTES} bytes in UTF-8`,
    });
  }
  return undefined;
}

export namespace AggregateId {
  export function of(
    typeName: string,
    value: string,
  ): Result<AggregateId, EventStoreError> {
    const violation = check(typeName, value);
    return violation === undefined
      ? Result.ok(Object.freeze({ typeName, value }))
      : Result.err(violation);
  }

  export function asString(id: AggregateId): Result<string, EventStoreError> {
    const violation = check(id.typeName, id.value);
    return violation === undefined
      ? Result.ok(`${id.typeName}-${id.value}`)
      : Result.err(violation);
  }
}

// Freeze the namespace so the functions cannot be replaced at runtime.
Object.freeze(AggregateId);
