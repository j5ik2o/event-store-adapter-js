declare const aggregateIdValueBrand: unique symbol;

type AggregateIdValue = string & {
  readonly [aggregateIdValueBrand]: "AggregateIdValue";
};

function createAggregateIdValue(value: string): AggregateIdValue {
  if (value.length === 0) {
    throw new Error("aggregateId value must be non-empty");
  }
  return value as AggregateIdValue;
}

export type { AggregateIdValue };
export { createAggregateIdValue };
