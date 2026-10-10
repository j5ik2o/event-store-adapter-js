import { compareExpectation } from "./conformance-expectation";

test("compares exact error category, rule and positive and negative message constraints", () => {
  const expectation = {
    error: {
      category: "contract-violation",
      rule: "T-9",
      message: { must_contain: ["seqNr=0"], must_not_contain: ["undefined"] },
    },
  };
  const actual = {
    kind: "error" as const,
    category: "contract-violation" as const,
    rule: "T-9",
    message: "seqNr=0",
  };
  expect(() => compareExpectation(expectation, actual, {}, {})).not.toThrow();
  expect(() =>
    compareExpectation(expectation, { kind: "ok", value: undefined }, {}, {}),
  ).toThrow("expected operation failure");
  expect(() =>
    compareExpectation({ result: "success" }, actual, {}, {}),
  ).toThrow("expected operation success");
  expect(() =>
    compareExpectation(expectation, { ...actual, rule: "W-2" }, {}, {}),
  ).toThrow();
  expect(() =>
    compareExpectation(
      expectation,
      { ...actual, message: "seqNr=0 undefined" },
      {},
      {},
    ),
  ).toThrow();
});

test("compares the entire restored envelope, metadata, array order and JSON value types", () => {
  const event = {
    aggregate_id: { type_name: "Order", value: "1" },
    seq_nr: BigInt(1),
    occurred_at: BigInt(0),
    payload: { ok: true },
  };
  const fixtures = { events: { e: event } };
  const actual = {
    kind: "ok" as const,
    value: [
      {
        aggregateId: { typeName: "Order", value: "1" },
        seqNr: BigInt(1),
        occurredAtEpochNanos: BigInt(0),
        manifest: "",
        payload: { ok: true },
      },
    ],
  };
  expect(() =>
    compareExpectation(
      { result: "events", events: ["e"] },
      actual,
      fixtures,
      {},
    ),
  ).not.toThrow();
  expect(() =>
    compareExpectation(
      { result: "events", events: ["e"] },
      { ...actual, value: [{ ...actual.value[0], payload: { ok: 1 } }] },
      fixtures,
      {},
    ),
  ).toThrow();
  expect(() =>
    compareExpectation(
      { result: "none" },
      { kind: "ok", value: { kind: "none" } },
      {},
      {},
    ),
  ).not.toThrow();
});
