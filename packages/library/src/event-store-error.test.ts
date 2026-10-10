import { EventStoreError } from "./event-store-error";

describe("EventStoreError.contractViolation", () => {
  test("builds a frozen contract-violation with the rule and seqNr in the message", () => {
    const error = EventStoreError.contractViolation({
      rule: "T-9",
      seqNr: -1,
    });

    expect(error.type).toBe("contract-violation");
    if (error.type !== "contract-violation") throw new Error("unreachable");
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

    if (error.type !== "contract-violation") throw new Error("unreachable");
    expect(error.snapshotSeqNr).toBe(5);
    expect(error.cause).toBe(cause);
    expect("seqNr" in error).toBe(false);
    expect(error.message).toContain("5");
  });

  test("includes both mismatched sequence numbers and the W-9 rule", () => {
    const error = EventStoreError.contractViolation({
      rule: "W-9",
      seqNr: 12,
      snapshotSeqNr: 9,
    });

    expect(error).toMatchObject({
      type: "contract-violation",
      rule: "W-9",
      seqNr: 12,
      snapshotSeqNr: 9,
    });
    expect(error.message).toContain("W-9");
    expect(error.message).toContain("seqNr=12");
    expect(error.message).toContain("snapshotSeqNr=9");
  });

  test("keeps zero sequence numbers and a supplied detail", () => {
    const error = EventStoreError.contractViolation({
      rule: "W-9",
      seqNr: 0,
      snapshotSeqNr: 0,
      detail: "number mismatch",
    });

    expect(error).toMatchObject({ seqNr: 0, snapshotSeqNr: 0 });
    expect(error.message).toContain("seqNr=0");
    expect(error.message).toContain("snapshotSeqNr=0");
    expect(error.message).toContain("number mismatch");
  });
});

describe("EventStoreError", () => {
  test("distinguishes all five categories by type even when messages coincide", () => {
    const conflict = EventStoreError.optimisticLockConflict({
      aggregateId: "Order-1",
      seqNr: 2,
    });
    const contract = EventStoreError.contractViolation({ rule: "T-2" });
    const errors: EventStoreError[] = [
      conflict,
      contract,
      EventStoreError.serialization("serialize", contract.message),
      EventStoreError.configuration("retention.count", contract.message),
      EventStoreError.storage(contract.message),
    ];

    const categories = errors.map((error) => {
      switch (error.type) {
        case "optimistic-lock-conflict":
          return error.type;
        case "contract-violation":
          return error.type;
        case "serialization-error":
          return error.type;
        case "configuration-error":
          return error.type;
        case "storage-error":
          return error.type;
        default: {
          const unexpected: never = error;
          throw new Error(`unexpected error: ${unexpected}`);
        }
      }
    });

    expect(categories).toEqual([
      "optimistic-lock-conflict",
      "contract-violation",
      "serialization-error",
      "configuration-error",
      "storage-error",
    ]);
    expect(errors.slice(1).map((error) => error.message)).toEqual(
      Array(4).fill(contract.message),
    );
  });

  test.each(["serialize", "deserialize"] as const)(
    "builds a serialization error for %s with a safe message and original cause",
    (operation) => {
      const cause = new Error("credentials=secret; raw SDK failure");

      const error = EventStoreError.serialization(
        operation,
        "payload failed",
        cause,
      );

      expect(error).toMatchObject({
        type: "serialization-error",
        operation,
        message: "payload failed",
      });
      expect(error.cause).toBe(cause);
    },
  );

  test("builds a configuration error with the field name and original cause", () => {
    const cause = { credentials: "secret" };

    const error = EventStoreError.configuration(
      "retention.count",
      "invalid count",
      cause,
    );

    expect(error).toMatchObject({
      type: "configuration-error",
      fieldName: "retention.count",
      message: "invalid count",
    });
    expect(error.cause).toBe(cause);
  });

  test("builds a storage error with a safe message and original cause", () => {
    const cause = new Error(
      "https://user:secret@storage.example; raw SDK failure",
    );

    const error = EventStoreError.storage("storage unavailable", cause);

    expect(error).toMatchObject({
      type: "storage-error",
      message: "storage unavailable",
    });
    expect(error.cause).toBe(cause);
  });

  test("builds an optimistic lock message from the aggregate and both sequence numbers", () => {
    const cause = new Error("credentials=secret; raw SDK failure");
    const input = { aggregateId: "Order-123", seqNr: 12, headSeqNr: 14 };

    const error = EventStoreError.optimisticLockConflict({ ...input, cause });
    const withoutCause = EventStoreError.optimisticLockConflict(input);

    expect(error).toMatchObject({ type: "optimistic-lock-conflict", ...input });
    expect(error.message).toContain("Order-123");
    expect(error.message).toContain("12");
    expect(error.message).toContain("14");
    expect(error.message).toBe(withoutCause.message);
    expect(error.cause).toBe(cause);
  });

  test("omits an unknown head sequence number from the optimistic lock error", () => {
    const error = EventStoreError.optimisticLockConflict({
      aggregateId: "Order-1",
      seqNr: 2,
    });

    expect(error).toMatchObject({
      type: "optimistic-lock-conflict",
      aggregateId: "Order-1",
      seqNr: 2,
    });
    expect(error.message).toContain("Order-1");
    expect(error.message).toContain("2");
    expect("headSeqNr" in error).toBe(false);
    expect(error.message).not.toContain("undefined");
  });

  test("keeps a known zero head sequence number in the optimistic lock error", () => {
    const error = EventStoreError.optimisticLockConflict({
      aggregateId: "Order-1",
      seqNr: 1,
      headSeqNr: 0,
    });

    expect(error).toMatchObject({ headSeqNr: 0 });
    expect(error.message).toContain("0");
  });
});
