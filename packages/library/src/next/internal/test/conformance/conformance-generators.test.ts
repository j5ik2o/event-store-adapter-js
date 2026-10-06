import { expandGenerators } from "./conformance-generators";
import { jsonAt } from "./conformance-json-lookup";

const gen = (target: string, character: string, byteLength: number) => ({
  target,
  character,
  byte_length: byteLength,
});

describe("expandGenerators", () => {
  test("repeats a one byte character to the byte length", () => {
    const out = expandGenerators({
      payload: "",
      generators: [gen("/payload", "x", 6)],
    });
    expect(jsonAt(out, "payload")).toBe("xxxxxx");
  });

  test("repeats a three byte character byte_length / 3 times", () => {
    const out = expandGenerators({
      payload: "",
      generators: [gen("/payload", "あ", 9)],
    });
    expect(jsonAt(out, "payload")).toBe("あああ");
  });

  test("decodes ~0 and ~1 in pointer segments", () => {
    const out = expandGenerators({
      "a/b": { "c~d": "" },
      generators: [gen("/a~1b/c~0d", "x", 2)],
    });
    expect(jsonAt(out, "a/b", "c~d")).toBe("xx");
  });

  test("does not mutate its input", () => {
    const input = Object.freeze({
      payload: "",
      generators: Object.freeze([gen("/payload", "x", 3)]),
    });
    const copy = JSON.stringify(input);
    expandGenerators(input);
    expect(JSON.stringify(input)).toBe(copy);
  });

  test("rejects a byte_length not divisible by the character width", () => {
    expect(() =>
      expandGenerators({
        payload: "",
        generators: [gen("/payload", "あ", 10)],
      }),
    ).toThrow();
  });

  test("rejects a target that is not an empty string", () => {
    expect(() =>
      expandGenerators({
        payload: "abc",
        generators: [gen("/payload", "x", 3)],
      }),
    ).toThrow();
  });

  test("rejects the same pointer twice", () => {
    expect(() =>
      expandGenerators({
        payload: "",
        generators: [gen("/payload", "x", 3), gen("/payload", "x", 3)],
      }),
    ).toThrow();
  });

  test("accepts U+FFFD as a valid three byte character", () => {
    const out = expandGenerators({
      payload: "",
      generators: [gen("/payload", "\uFFFD", 6)],
    });
    expect(jsonAt(out, "payload")).toBe("\uFFFD\uFFFD");
  });
});
