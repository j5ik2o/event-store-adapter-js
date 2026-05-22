import type { AggregateIdValue } from "./aggregate-id-value";

interface AggregateId {
  typeName: string;
  value: AggregateIdValue;
  asString: () => string;
}

export type { AggregateId };
