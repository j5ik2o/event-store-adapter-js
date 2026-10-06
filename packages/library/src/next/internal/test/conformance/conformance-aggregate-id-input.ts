import type { ConformanceCase } from "./conformance-case";
import { jsonAt } from "./conformance-json-lookup";

export type ConformanceAggregateIdInput = {
  typeName: string;
  value: string;
  userString: string | undefined;
};

export function aggregateIdInputOf(
  c: ConformanceCase,
): ConformanceAggregateIdInput {
  const typeName = jsonAt(c.body, "input", "aggregate_id", "type_name");
  const value = jsonAt(c.body, "input", "aggregate_id", "value");
  const userString = jsonAt(c.body, "input", "user_string");
  if (
    jsonAt(c.body, "operation") !== "buildAid" ||
    typeof typeName !== "string" ||
    typeof value !== "string"
  ) {
    throw new Error(`${c.id}: not a buildAid case`);
  }
  return {
    typeName,
    value,
    userString: typeof userString === "string" ? userString : undefined,
  };
}
