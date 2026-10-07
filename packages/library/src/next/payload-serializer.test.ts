import { EventEnvelope } from "./event-envelope";
import { EventStoreError } from "./event-store-error";
import { PayloadSerializer } from "./payload-serializer";

describe("PayloadSerializer", () => {
  test("round-trips a domain class without library-specific members", () => {
    class Quantity {
      constructor(readonly amount: bigint) {}
    }
    const serializer: PayloadSerializer<Quantity> = {
      serialize: (payload: Quantity) =>
        new TextEncoder().encode(String(payload.amount)),
      deserialize: (bytes: Uint8Array, _manifest: string) =>
        new Quantity(BigInt(new TextDecoder().decode(bytes))),
    };
    const payload = new Quantity(BigInt(123));

    const restored = serializer.deserialize(serializer.serialize(payload), "");

    expect(restored).toBeInstanceOf(Quantity);
    expect(restored.amount).toBe(BigInt(123));
  });

  test("serializes only the envelope payload as UTF-8 JSON", () => {
    const serializer = PayloadSerializer.json();
    const result = EventEnvelope.create({
      aggregateId: { typeName: "Order", value: "1" },
      seqNr: 12,
      occurredAt: new Date(0),
      manifest: "OrderCreated",
      payload: { title: "注文😀" },
    });
    if (result.type !== "ok") throw new Error("expected ok");

    const bytes = serializer.serialize(result.value.payload);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(new TextEncoder().encode('{"title":"注文😀"}'));
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      title: "注文😀",
    });
  });

  test("preserves payload keys that have metadata or legacy wrapper names", () => {
    const serializer = PayloadSerializer.json();
    const payload = {
      aggregateId: "payload-id",
      seqNr: 0,
      occurredAt: "payload-time",
      manifest: "payload-manifest",
      type: "payload-type",
      data: { value: 1 },
    };

    const bytes = serializer.serialize(payload);

    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(payload);
    expect(serializer.deserialize(bytes, "envelope-manifest")).toEqual(payload);
  });

  test.each([
    { name: "null", payload: null },
    { name: "true", payload: true },
    { name: "false", payload: false },
    { name: "empty string", payload: "" },
    { name: "Unicode string", payload: "注文😀" },
    { name: "zero", payload: 0 },
    { name: "negative fraction", payload: -12.5 },
    { name: "empty array", payload: [] },
    { name: "nested array", payload: [null, false, 0, ["日本語"]] },
    { name: "empty object", payload: {} },
    { name: "nested object", payload: { value: { items: [null, true, 1] } } },
  ])("round-trips $name through UTF-8 JSON", ({ payload }) => {
    const serializer = PayloadSerializer.json();

    const restored = serializer.deserialize(serializer.serialize(payload), "");

    expect(restored).toEqual(payload);
  });

  test("does not interpret manifests when restoring JSON", () => {
    const serializer = PayloadSerializer.json();
    const bytes = new TextEncoder().encode('{"value":1}');

    const restored = ["", "UnknownType", "注文/😀"].map((manifest) =>
      serializer.deserialize(bytes, manifest),
    );

    expect(restored).toEqual([{ value: 1 }, { value: 1 }, { value: 1 }]);
  });

  test("passes the manifest unchanged to a custom deserializer", () => {
    const serializer: PayloadSerializer<string> = {
      serialize: (payload: string) => new TextEncoder().encode(payload),
      deserialize: (bytes: Uint8Array, manifest: string) =>
        `${manifest}:${new TextDecoder().decode(bytes)}`,
    };
    const manifest = "注文/😀 v2";

    const restored = serializer.deserialize(
      serializer.serialize("value"),
      manifest,
    );

    expect(restored).toBe(`${manifest}:value`);
  });

  test.each([
    { name: "undefined", payload: undefined },
    { name: "function", payload: () => 1 },
    { name: "BigInt", payload: BigInt(1) },
    { name: "symbol", payload: Symbol("value") },
    { name: "NaN", payload: Number.NaN },
    { name: "positive infinity", payload: Number.POSITIVE_INFINITY },
    { name: "negative infinity", payload: Number.NEGATIVE_INFINITY },
    { name: "object containing undefined", payload: { value: undefined } },
    { name: "object containing a function", payload: { value: () => 1 } },
    { name: "object containing BigInt", payload: { value: BigInt(1) } },
    { name: "array containing undefined", payload: [undefined] },
    { name: "array containing a function", payload: [() => 1] },
    { name: "array containing BigInt", payload: [BigInt(1)] },
    { name: "object containing a symbol", payload: { value: Symbol("value") } },
    { name: "array containing NaN", payload: [Number.NaN] },
  ])("throws instead of successfully serializing $name", ({ payload }) => {
    const serializer = PayloadSerializer.json();

    expect(() => serializer.serialize(payload)).toThrow();
  });

  test("throws instead of successfully serializing a circular payload", () => {
    const serializer = PayloadSerializer.json();
    const payload: { self?: unknown } = {};
    // 循環入力を作るため、このテスト内でのみ変更する。
    payload.self = payload;

    expect(() => serializer.serialize(payload)).toThrow();
  });

  test("rejects malformed UTF-8 instead of replacing payload characters", () => {
    const serializer = PayloadSerializer.json();
    const malformed = new Uint8Array([0x22, 0xc3, 0x28, 0x22]);

    expect(() => serializer.deserialize(malformed, "")).toThrow();
  });

  test.each(["", '{"value":', "{invalid}"])(
    "throws instead of restoring malformed JSON %j",
    (json) => {
      const serializer = PayloadSerializer.json();
      const bytes = new TextEncoder().encode(json);

      expect(() => serializer.deserialize(bytes, "")).toThrow();
    },
  );

  test.each(["serialize", "deserialize"] as const)(
    "allows the caller to classify a caught %s failure with its original cause",
    (operation) => {
      const serializer = PayloadSerializer.json();
      let caught: unknown;

      // 保存先による捕捉・分類の境界を直接試験する。保存先への接続は行わない。
      try {
        if (operation === "serialize") serializer.serialize(BigInt(1));
        else serializer.deserialize(new TextEncoder().encode("{"), "");
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = EventStoreError.serialization(
        operation,
        "payload failed",
        caught,
      );

      expect(error).toMatchObject({ type: "serialization-error", operation });
      expect(error.cause).toBe(caught);
    },
  );

  test("propagates an exception thrown by payload serialization unchanged", () => {
    const serializer = PayloadSerializer.json();
    const cause = new Error("domain serialization failed");
    const payload = {
      toJSON: () => {
        throw cause;
      },
    };

    expect.assertions(1);
    try {
      serializer.serialize(payload);
    } catch (caught) {
      expect(caught).toBe(cause);
    }
  });

  test.each(["serialize", "deserialize"] as const)(
    "classifies a custom serializer's %s exception with its original cause",
    (operation) => {
      const cause = { domain: "unsupported payload", credentials: "secret" };
      const serializer: PayloadSerializer<string> = {
        serialize: (_payload: string) => {
          throw cause;
        },
        deserialize: (_bytes: Uint8Array, _manifest: string) => {
          throw cause;
        },
      };

      // 後続の保存先が担当する捕捉・分類を試験内で確認する。
      expect.assertions(2);
      try {
        if (operation === "serialize") serializer.serialize("value");
        else serializer.deserialize(new Uint8Array(), "domain-v2");
      } catch (caught) {
        const error = EventStoreError.serialization(
          operation,
          "payload failed",
          caught,
        );
        expect(error).toMatchObject({
          type: "serialization-error",
          operation,
          message: "payload failed",
        });
        expect(error.cause).toBe(cause);
      }
    },
  );
});
