import type { MemoryEventStoreInput } from "../memory-event-store-input";
import { validateEventStoreInput } from "./event-store-input-validation";

describe("validateEventStoreInput", () => {
  test.each([
    undefined,
    {},
    { eventSerializer: undefined, snapshotSerializer: undefined },
  ])("defaults omitted serializers %p to JSON", (input) => {
    const result = validateEventStoreInput(input);
    if (result.type !== "ok") throw new Error("expected common settings");
    const event = { message: "イベント", value: null };
    const snapshot = { balance: 1 };

    expect(
      result.value.eventSerializer.deserialize(
        result.value.eventSerializer.serialize(event),
        "event-manifest",
      ),
    ).toEqual(event);
    expect(
      result.value.snapshotSerializer.deserialize(
        result.value.snapshotSerializer.serialize(snapshot),
        "snapshot-manifest",
      ),
    ).toEqual(snapshot);
    expect(result.value.onRetentionFailure).toBeUndefined();
    expect(result.value.logger).toBeUndefined();
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  test("keeps supplied serializers, callback and logger without calling them", () => {
    const eventSerializer = { serialize: jest.fn(), deserialize: jest.fn() };
    const snapshotSerializer = { serialize: jest.fn(), deserialize: jest.fn() };
    const onRetentionFailure = jest.fn();
    const logger = {
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const input = {
      eventSerializer,
      snapshotSerializer,
      onRetentionFailure,
      logger,
    };

    const result = validateEventStoreInput(input);

    if (result.type !== "ok") throw new Error("expected common settings");
    expect(result.value.eventSerializer).toBe(eventSerializer);
    expect(result.value.snapshotSerializer).toBe(snapshotSerializer);
    expect(result.value.onRetentionFailure).toBe(onRetentionFailure);
    expect(result.value.logger).toBe(logger);
    for (const callable of [
      ...Object.values(eventSerializer),
      ...Object.values(snapshotSerializer),
      ...Object.values(logger),
      onRetentionFailure,
    ]) {
      expect(callable).not.toHaveBeenCalled();
    }
    for (const supplied of [
      input,
      eventSerializer,
      snapshotSerializer,
      logger,
    ]) {
      expect(Object.isFrozen(supplied)).toBe(false);
    }
  });

  describe.each(["eventSerializer", "snapshotSerializer"] as const)(
    "%s validation",
    (fieldName) => {
      test.each([
        null,
        0,
        false,
        "json",
        {},
        { serialize: () => new Uint8Array() },
        { deserialize: () => null },
        { serialize: null, deserialize: () => null },
        { serialize: () => new Uint8Array(), deserialize: 1 },
      ])("rejects invalid serializer %p without defaulting", (serializer) => {
        expect(
          validateEventStoreInput({
            [fieldName]: serializer,
          } as MemoryEventStoreInput<unknown, unknown>),
        ).toMatchObject({
          type: "err",
          error: { type: "configuration-error", fieldName },
        });
      });
    },
  );

  test.each([null, false, 0, "callback", {}, []])(
    "rejects invalid onRetentionFailure %p",
    (onRetentionFailure) => {
      expect(
        validateEventStoreInput({
          onRetentionFailure,
        } as unknown as MemoryEventStoreInput<unknown, unknown>),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "onRetentionFailure" },
      });
    },
  );

  test("allows logger without optional trace", () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    expect(validateEventStoreInput({ logger })).toMatchObject({
      type: "ok",
      value: { logger },
    });
  });

  test.each(["debug", "info", "warn", "error", "trace"] as const)(
    "rejects invalid logger method %s",
    (method) => {
      const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        [method]: null,
      };
      expect(
        validateEventStoreInput({ logger } as unknown as MemoryEventStoreInput<
          unknown,
          unknown
        >),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "logger" },
      });
    },
  );

  test.each(["debug", "info", "warn", "error"] as const)(
    "rejects missing required logger method %s",
    (method) => {
      const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const { [method]: _omitted, ...missingMethod } = logger;
      expect(
        validateEventStoreInput({
          logger: missingMethod,
        } as MemoryEventStoreInput<unknown, unknown>),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "logger" },
      });
    },
  );

  test.each([null, false, 0, "logger"])(
    "rejects invalid logger %p",
    (logger) => {
      expect(
        validateEventStoreInput({ logger } as unknown as MemoryEventStoreInput<
          unknown,
          unknown
        >),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "logger" },
      });
    },
  );

  test.each([null, false, 0, "settings", []])(
    "rejects invalid common settings %p",
    (input) => {
      expect(
        validateEventStoreInput(
          input as unknown as MemoryEventStoreInput<unknown, unknown>,
        ),
      ).toMatchObject({
        type: "err",
        error: { type: "configuration-error", fieldName: "input" },
      });
    },
  );
});
