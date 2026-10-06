import { validateOccurredAt } from "./occurred-at-validation";

describe("validateOccurredAt", () => {
  test.each([-9223372036854, 9223372036854, 0])(
    "accepts Date(%s) and returns it",
    (ms) => {
      const date = new Date(ms);

      expect(validateOccurredAt(date)).toEqual({ type: "ok", value: date });
    },
  );

  test.each([-9223372036855, 9223372036855])(
    "rejects Date(%s) with T-13 and the seqNr",
    (ms) => {
      const result = validateOccurredAt(new Date(ms), 7);

      expect(result.type).toBe("err");
      if (result.type !== "err") throw new Error("unreachable");
      expect(result.error).toMatchObject({ rule: "T-13", seqNr: 7 });
      expect(result.error.message).toContain("T-13");
      expect(result.error.message).toContain("7");
    },
  );

  test("rejects an invalid Date with T-13", () => {
    const result = validateOccurredAt(new Date(Number.NaN));

    expect(result.type).toBe("err");
    if (result.type !== "err") throw new Error("unreachable");
    expect(result.error).toMatchObject({ rule: "T-13" });
    expect("seqNr" in result.error).toBe(false);
  });

  test.each([0, "2020-01-01", null, undefined, {}])(
    "rejects non-Date %p with T-13",
    (value) => {
      const result = validateOccurredAt(value);

      expect(result.type).toBe("err");
      if (result.type !== "err") throw new Error("unreachable");
      expect(result.error).toMatchObject({ rule: "T-13" });
    },
  );
});
