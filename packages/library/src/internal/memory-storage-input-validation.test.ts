import type { MemoryStorageInput } from "../memory-storage-input";
import { validateMemoryStorageInput } from "./memory-storage-input-validation";

describe("validateMemoryStorageInput", () => {
  test.each([undefined, {}, { retention: undefined, changeFeed: undefined }])(
    "omitted settings %p mean no history retention",
    (input) => {
      expect(validateMemoryStorageInput(input)).toEqual({
        type: "ok",
        value: { retention: undefined },
      });
    },
  );

  test.each([undefined, { type: "delete" as const }])(
    "accepts delete retention with mode %p",
    (mode) => {
      expect(
        validateMemoryStorageInput({ retention: { count: 1, mode } }),
      ).toEqual({
        type: "ok",
        value: { retention: { count: 1, mode: { type: "delete" } } },
      });
    },
  );

  test("accepts count above the safe-integer range", () => {
    expect(
      validateMemoryStorageInput({ retention: { count: 2 ** 53 } }),
    ).toMatchObject({ type: "ok", value: { retention: { count: 2 ** 53 } } });
  });

  test("propagates invalid retention as a configuration error", () => {
    expect(
      validateMemoryStorageInput({ retention: { count: 0 } }),
    ).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "retention.count" },
    });
  });

  test("rejects a valid ttl request because memory does not provide ttl", () => {
    expect(
      validateMemoryStorageInput({
        retention: { count: 1, mode: { type: "ttl", graceSeconds: 0 } },
      }),
    ).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "retention.mode.type" },
    });
  });

  test.each([false, true, null, 0, "", "stream", {}, [], () => undefined])(
    "rejects every defined changeFeed value %p with fieldName changeFeed",
    (changeFeed) => {
      expect(validateMemoryStorageInput({ changeFeed })).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "changeFeed" },
      });
    },
  );

  test.each([null, 0, false, "settings", []])(
    "rejects an invalid settings object %p",
    (input) => {
      expect(
        validateMemoryStorageInput(input as unknown as MemoryStorageInput),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "input" },
      });
    },
  );

  test("does not mutate caller input or retain mutable retention settings", () => {
    const input = { retention: { count: 1 } };
    const result = validateMemoryStorageInput(input);
    expect(input).toEqual({ retention: { count: 1 } });

    input.retention.count = 0;

    expect(result).toEqual({
      type: "ok",
      value: { retention: { count: 1, mode: { type: "delete" } } },
    });
    if (result.type !== "ok") throw new Error("expected memory settings");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });
});
