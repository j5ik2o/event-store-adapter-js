import type { Result } from "../result";
import { EventEnvelope } from "./event-envelope";
import type { EventEnvelopeInput } from "./event-envelope-input";
import type { EventStoreError } from "./event-store-error";

const aggregateId = { typeName: "Order", value: "1" };
const validInput = (): EventEnvelopeInput<unknown> => ({
  aggregateId,
  seqNr: 1,
  occurredAt: new Date(9223372036854),
  payload: null,
});

const errorOf = <T>(result: Result<T, EventStoreError>): EventStoreError => {
  if (result.type !== "err") {
    throw new Error("expected err");
  }
  return result.error;
};

const untyped = (input: unknown) =>
  EventEnvelope.create(input as EventEnvelopeInput<unknown>);

describe("EventEnvelope.create", () => {
  test("creates a frozen envelope with an empty manifest when omitted", () => {
    const result = EventEnvelope.create(validInput());

    expect(result.type).toBe("ok");
    if (result.type !== "ok") throw new Error("unreachable");
    expect(result.value.manifest).toBe("");
    expect(result.value.payload).toBeNull();
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  test("keeps a given manifest and does not modify the input", () => {
    const input = { ...validInput(), manifest: "m" };
    const snapshot = { ...input };
    const result = EventEnvelope.create(input);

    expect(result).toMatchObject({ type: "ok", value: { manifest: "m" } });
    expect(input).toEqual(snapshot);
    const omitted = validInput();
    EventEnvelope.create(omitted);
    expect("manifest" in omitted).toBe(false);
  });

  describe("caller property snapshot", () => {
    const keys = [
      "aggregateId",
      "seqNr",
      "occurredAt",
      "manifest",
      "payload",
    ] as const;

    test.each(keys)("keeps the first %s getter value", (key) => {
      const first = {
        ...validInput(),
        manifest: "m",
        payload: { item: "book" },
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
      expect(result.value.payload).toBe(first.payload);
      for (const getter of Object.values(getters)) {
        expect(getter).toHaveBeenCalledTimes(1);
      }
    });

    test.each(["aggregateId", "seqNr", "occurredAt", "payload"])(
      "rejects a first missing %s getter value with T-2",
      (key) => {
        const values = { ...validInput(), manifest: "m", seqNr: 7 };
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
          rule: "T-2",
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

  test("rejects seqNr 0 with W-6 and the seqNr in the message", () => {
    const error = errorOf(EventEnvelope.create({ ...validInput(), seqNr: 0 }));

    expect(error).toMatchObject({ type: "contract-violation", rule: "W-6" });
    expect(error.message).toContain("W-6");
    expect(error.message).toContain("0");
  });

  test("rejects an out-of-range occurredAt with T-13 and the seqNr", () => {
    const error = errorOf(
      EventEnvelope.create({
        ...validInput(),
        seqNr: 7,
        occurredAt: new Date(9223372036855),
      }),
    );

    expect(error).toMatchObject({ rule: "T-13", seqNr: 7 });
    expect(error.message).toContain("T-13");
    expect(error.message).toContain("7");
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects seqNr %s with T-9",
    (seqNr) => {
      expect(
        errorOf(EventEnvelope.create({ ...validInput(), seqNr })),
      ).toMatchObject({
        rule: "T-9",
      });
    },
  );

  test.each(["aggregateId", "seqNr", "occurredAt"])(
    "rejects a missing %s (undefined and null) with T-2",
    (key) => {
      for (const missing of [undefined, null]) {
        const error = errorOf(untyped({ ...validInput(), [key]: missing }));

        expect(error).toMatchObject({
          type: "contract-violation",
          rule: "T-2",
        });
        expect(error.message).toContain("T-2");
        expect(error.message).toContain(key);
      }
    },
  );

  test("rejects a missing payload (undefined) with T-2 but accepts null", () => {
    expect(
      errorOf(untyped({ ...validInput(), payload: undefined })),
    ).toMatchObject({ rule: "T-2" });
    expect(EventEnvelope.create({ ...validInput(), payload: null }).type).toBe(
      "ok",
    );
  });

  test("does not put a seqNr in the error when seqNr is the missing element", () => {
    const error = errorOf(untyped({ ...validInput(), seqNr: undefined }));

    expect("seqNr" in error).toBe(false);
  });

  test("puts the seqNr in the error when another element is missing", () => {
    const error = errorOf(untyped({ ...validInput(), aggregateId: undefined }));

    expect(error).toMatchObject({ seqNr: 1 });
  });

  test.each([undefined, null])(
    "returns T-2 without throwing when the whole input is %p",
    (input) => {
      const error = errorOf(untyped(input));

      expect(error).toMatchObject({ rule: "T-2" });
      expect("seqNr" in error).toBe(false);
    },
  );
});
