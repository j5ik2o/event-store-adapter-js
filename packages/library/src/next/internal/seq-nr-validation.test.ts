import { validateSeqNr } from "./seq-nr-validation";

describe("validateSeqNr", () => {
  test.each([0, 1, Number.MAX_SAFE_INTEGER])(
    "accepts %s and returns it",
    (n) => {
      expect(validateSeqNr(n)).toEqual({ type: "ok", value: n });
    },
  );

  test.each([-1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects %s with T-9 and the value in the message",
    (n) => {
      const result = validateSeqNr(n);

      expect(result.type).toBe("err");
      if (result.type !== "err") throw new Error("unreachable");
      expect(result.error).toMatchObject({
        type: "contract-violation",
        rule: "T-9",
      });
      expect(result.error.message).toContain("T-9");
      expect(result.error.message).toContain(String(n));
    },
  );

  test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined])(
    "rejects non-integer or non-number %p with T-9",
    (n) => {
      const result = validateSeqNr(n);

      expect(result.type).toBe("err");
      if (result.type !== "err") throw new Error("unreachable");
      expect(result.error).toMatchObject({ rule: "T-9" });
    },
  );
});
