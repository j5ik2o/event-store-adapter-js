import { validateOccurredAt } from "./occurred-at-validation";

describe("validateOccurredAt", () => {
  test.each([-9223372036854, 9223372036854, 0])(
    "accepts Date(%s) and returns an independent Date with the same time",
    (ms) => {
      const date = new Date(ms);

      const result = validateOccurredAt(date);

      expect(result).toEqual({ type: "ok", value: new Date(ms) });
      if (result.type !== "ok") throw new Error("expected ok");
      expect(result.value).not.toBe(date);
      date.setTime(Number.NaN);
      expect(result.value.getTime()).toBe(ms);
    },
  );

  test("copies the validated milliseconds without rereading getTime", () => {
    const date = new Date(7);
    const getTime = jest
      .fn()
      .mockReturnValueOnce(7)
      .mockReturnValue(9223372036855);
    date.getTime = getTime;

    const result = validateOccurredAt(date);

    expect(result.type).toBe("ok");
    if (result.type !== "ok") throw new Error("expected ok");
    expect(result.value.getTime()).toBe(7);
    expect(result.value).not.toBe(date);
    expect(getTime).toHaveBeenCalledTimes(1);
  });

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
