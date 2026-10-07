import { EventStoreError } from "./event-store-error";

describe("EventStoreError.contractViolation", () => {
  test("builds a frozen contract-violation with the rule and seqNr in the message", () => {
    const error = EventStoreError.contractViolation({
      rule: "T-9",
      seqNr: -1,
    });

    expect(error.type).toBe("contract-violation");
    expect(error.rule).toBe("T-9");
    expect(error.message).toContain("T-9");
    expect(error.message).toContain("-1");
    expect(error.seqNr).toBe(-1);
    expect(Object.isFrozen(error)).toBe(true);
  });

  test("omits the seqNr key and its text when seqNr is not given", () => {
    const error = EventStoreError.contractViolation({ rule: "T-2" });

    expect("seqNr" in error).toBe(false);
    expect("snapshotSeqNr" in error).toBe(false);
    expect("cause" in error).toBe(false);
    expect(error.message).toContain("T-2");
    expect(error.message).not.toContain("undefined");
  });

  test("keeps snapshotSeqNr and cause only when given", () => {
    const cause = new Error("boom");
    const error = EventStoreError.contractViolation({
      rule: "D-7",
      snapshotSeqNr: 5,
      cause,
    });

    expect(error.snapshotSeqNr).toBe(5);
    expect(error.cause).toBe(cause);
    expect("seqNr" in error).toBe(false);
    expect(error.message).toContain("5");
  });
});
