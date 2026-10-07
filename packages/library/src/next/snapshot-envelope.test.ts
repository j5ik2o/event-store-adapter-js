import type { Result } from "../result";
import type { EventStoreError } from "./event-store-error";
import { SnapshotEnvelope } from "./snapshot-envelope";
import type { SnapshotEnvelopeInput } from "./snapshot-envelope-input";

const errorOf = <T>(result: Result<T, EventStoreError>): EventStoreError => {
  if (result.type !== "err") {
    throw new Error("expected err");
  }
  return result.error;
};

const untyped = (input: unknown) =>
  SnapshotEnvelope.create(input as SnapshotEnvelopeInput<unknown>);

describe("SnapshotEnvelope.create", () => {
  test("accepts seqNr 0 and a null aggregate, fills manifest and freezes", () => {
    const result = SnapshotEnvelope.create({ seqNr: 0, aggregate: null });

    expect(result.type).toBe("ok");
    if (result.type !== "ok") throw new Error("unreachable");
    expect(result.value).toMatchObject({
      seqNr: 0,
      aggregate: null,
      manifest: "",
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  test("keeps a given manifest and does not modify the input", () => {
    const input = { seqNr: 3, aggregate: { a: 1 }, manifest: "m" };
    const snapshot = { ...input };
    const result = SnapshotEnvelope.create(input);

    expect(result).toMatchObject({ type: "ok", value: { manifest: "m" } });
    expect(input).toEqual(snapshot);
    const omitted: SnapshotEnvelopeInput<unknown> = { seqNr: 1, aggregate: 1 };
    SnapshotEnvelope.create(omitted);
    expect("manifest" in omitted).toBe(false);
  });

  describe("caller property snapshot", () => {
    test.each(["seqNr", "manifest", "aggregate"])(
      "keeps the first %s getter value",
      (key) => {
        const first = {
          seqNr: 3,
          manifest: "m",
          aggregate: { items: ["book"] },
        };
        const getters = Object.fromEntries(
          Object.entries(first).map(([name, value]) => [
            name,
            jest
              .fn()
              .mockReturnValueOnce(value)
              .mockReturnValue(name === key ? undefined : value),
          ]),
        );
        const input = Object.defineProperties(
          {},
          Object.fromEntries(
            Object.entries(getters).map(([name, get]) => [name, { get }]),
          ),
        );

        const result = untyped(input);

        expect(result).toEqual({ type: "ok", value: first });
        if (result.type !== "ok") throw new Error("expected ok");
        expect(result.value.aggregate).toBe(first.aggregate);
        for (const getter of Object.values(getters)) {
          expect(getter).toHaveBeenCalledTimes(1);
        }
      },
    );

    test.each(["seqNr", "aggregate"])(
      "rejects a first missing %s getter value with T-10",
      (key) => {
        const values = { seqNr: 7, manifest: "m", aggregate: null };
        const getters = Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            jest
              .fn()
              .mockReturnValueOnce(name === key ? undefined : value)
              .mockReturnValue(value),
          ]),
        );
        const input = Object.defineProperties(
          {},
          Object.fromEntries(
            Object.entries(getters).map(([name, get]) => [name, { get }]),
          ),
        );

        const error = errorOf(untyped(input));

        expect(error).toMatchObject({
          type: "contract-violation",
          rule: "T-10",
        });
        expect(error.message).toContain(key);
        if (key === "seqNr") {
          expect(error).not.toHaveProperty("seqNr");
          expect(error.message).not.toContain("seqNr=");
        } else {
          expect(error).toHaveProperty("seqNr", 7);
          expect(error.message).toContain("seqNr=7");
        }
        for (const getter of Object.values(getters)) {
          expect(getter).toHaveBeenCalledTimes(1);
        }
      },
    );
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects seqNr %s with T-9",
    (seqNr) => {
      expect(
        errorOf(SnapshotEnvelope.create({ seqNr, aggregate: 1 })),
      ).toMatchObject({
        rule: "T-9",
      });
    },
  );

  test.each([undefined, null])(
    "rejects seqNr %p with T-10 and no seqNr in the error",
    (seqNr) => {
      const error = errorOf(untyped({ seqNr, aggregate: 1 }));

      expect(error).toMatchObject({
        type: "contract-violation",
        rule: "T-10",
      });
      expect(error.message).toContain("T-10");
      expect("seqNr" in error).toBe(false);
    },
  );

  test("rejects an undefined aggregate with T-10", () => {
    const error = errorOf(untyped({ seqNr: 2, aggregate: undefined }));

    expect(error).toMatchObject({ rule: "T-10" });
  });

  test.each([undefined, null])(
    "returns T-10 without throwing when the whole input is %p",
    (input) => {
      expect(errorOf(untyped(input))).toMatchObject({ rule: "T-10" });
    },
  );
});
