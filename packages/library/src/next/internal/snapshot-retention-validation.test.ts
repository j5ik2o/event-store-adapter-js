import { validateSnapshotRetention } from "./snapshot-retention-validation";

describe("validateSnapshotRetention", () => {
  test("undefined means no history retention", () => {
    expect(validateSnapshotRetention(undefined)).toEqual({
      type: "ok",
      value: undefined,
    });
  });

  test.each([1, 2, Number.MAX_SAFE_INTEGER, 2 ** 53, Number.MAX_VALUE])(
    "accepts count %p without adding a safe-integer upper bound",
    (count) => {
      expect(validateSnapshotRetention({ count })).toEqual({
        type: "ok",
        value: { count, mode: { type: "delete" } },
      });
    },
  );

  test.each([
    undefined,
    null,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "1",
    true,
    BigInt(1),
    { toString: null, valueOf: null },
  ])("rejects invalid count %p as a configuration error", (count) => {
    expect(validateSnapshotRetention({ count })).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "retention.count" },
    });
  });

  test.each([null, false, 1, "retention", [], () => 1])(
    "rejects an invalid retention object %p",
    (retention) => {
      expect(validateSnapshotRetention(retention)).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "retention" },
      });
    },
  );

  test.each([undefined, { type: "delete" }])(
    "normalizes omitted mode and explicit delete %p to delete",
    (mode) => {
      expect(validateSnapshotRetention({ count: 1, mode })).toEqual({
        type: "ok",
        value: { count: 1, mode: { type: "delete" } },
      });
    },
  );

  test.each([null, "delete", false, 0, [], () => "delete"])(
    "rejects an invalid mode object %p instead of defaulting",
    (mode) => {
      expect(validateSnapshotRetention({ count: 1, mode })).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "retention.mode" },
      });
    },
  );

  test.each([{}, { type: undefined }, { type: null }, { type: "unknown" }])(
    "rejects a missing or unknown mode type %p",
    (mode) => {
      expect(validateSnapshotRetention({ count: 1, mode })).toMatchObject({
        type: "err",
        error: {
          type: "configuration-error",
          fieldName: "retention.mode.type",
        },
      });
    },
  );

  test.each([0, 1, Number.MAX_SAFE_INTEGER])(
    "accepts ttl graceSeconds %p",
    (graceSeconds) => {
      expect(
        validateSnapshotRetention({
          count: 1,
          mode: { type: "ttl", graceSeconds },
        }),
      ).toEqual({
        type: "ok",
        value: { count: 1, mode: { type: "ttl", graceSeconds } },
      });
    },
  );

  test.each([
    undefined,
    null,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    2 ** 53 + 2,
    "0",
    false,
    BigInt(0),
    { toString: null, valueOf: null },
  ])("rejects invalid ttl graceSeconds %p", (graceSeconds) => {
    expect(
      validateSnapshotRetention({
        count: 1,
        mode: { type: "ttl", graceSeconds },
      }),
    ).toMatchObject({
      type: "err",
      error: {
        type: "configuration-error",
        fieldName: "retention.mode.graceSeconds",
      },
    });
  });

  test("retention and mode are independent immutable values", () => {
    const input = { count: 2, mode: { type: "ttl", graceSeconds: 0 } };
    const result = validateSnapshotRetention(input);
    if (result.type !== "ok" || result.value === undefined) {
      throw new Error("expected retention settings");
    }

    input.count = 0;
    input.mode.graceSeconds = -1;

    expect(result.value).toEqual({
      count: 2,
      mode: { type: "ttl", graceSeconds: 0 },
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.mode)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.mode)).toBe(false);
  });

  test("uses each retrieved setting once for validation and output", () => {
    const count = jest.fn().mockReturnValueOnce(1).mockReturnValue(0);
    const type = jest
      .fn()
      .mockReturnValueOnce("ttl")
      .mockReturnValue("unknown");
    const graceSeconds = jest.fn().mockReturnValueOnce(0).mockReturnValue(-1);
    const mode = jest.fn().mockReturnValueOnce({
      get type() {
        return type();
      },
      get graceSeconds() {
        return graceSeconds();
      },
    });

    const result = validateSnapshotRetention({
      get count() {
        return count();
      },
      get mode() {
        return mode();
      },
    });

    expect(result).toEqual({
      type: "ok",
      value: { count: 1, mode: { type: "ttl", graceSeconds: 0 } },
    });
    for (const getter of [count, mode, type, graceSeconds]) {
      expect(getter).toHaveBeenCalledTimes(1);
    }
  });
});
