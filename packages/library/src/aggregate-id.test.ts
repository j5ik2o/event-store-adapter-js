import { AggregateId } from "./aggregate-id";
import type { EventStoreError } from "./event-store-error";
import type { Result } from "./result";

const unwrap = <T>(result: Result<T, EventStoreError>): T => {
  if (result.type !== "ok") {
    throw new Error(`expected ok but got ${result.error.message}`);
  }
  return result.value;
};

const errorOf = <T>(result: Result<T, EventStoreError>): EventStoreError => {
  if (result.type !== "err") {
    throw new Error("expected err");
  }
  return result.error;
};

describe("AggregateId", () => {
  test("asString builds the string from typeName and value, ignoring custom toString", () => {
    const id = unwrap(AggregateId.of("Order", "123"));
    const tampered = Object.assign({}, id, {
      toString: () => "custom-display-value",
      asString: () => "custom-display-value",
    });

    expect(unwrap(AggregateId.asString(tampered))).toBe("Order-123");
  });

  test.each([
    ["order", "item-1", "order-item-1"],
    ["", "v", "-v"],
    ["t", "", "t-"],
    ["", "", "-"],
  ])("accepts (%j, %j) and renders %j", (typeName, value, expected) => {
    const id = unwrap(AggregateId.of(typeName, value));

    expect(id.typeName).toBe(typeName);
    expect(id.value).toBe(value);
    expect(unwrap(AggregateId.asString(id))).toBe(expected);
  });

  test("accepts exactly 1024 UTF-8 bytes", () => {
    const value = `${"あ".repeat(339)}abc`;
    const id = unwrap(AggregateId.of("型", value));

    expect(unwrap(AggregateId.asString(id))).toBe(`型-${value}`);
  });

  test("accepts 1024 ASCII bytes and rejects 1025 with T-12", () => {
    const ok = AggregateId.of("a", "b".repeat(1022));
    const ng = AggregateId.of("a", "b".repeat(1023));

    expect(ok.type).toBe("ok");
    expect(errorOf(ng).type).toBe("contract-violation");
    expect(errorOf(ng)).toMatchObject({ rule: "T-12" });
  });

  test("rejects 1025 UTF-8 bytes with T-12 even though the character count is lower", () => {
    const value = `${"あ".repeat(339)}a${"あ"}`;

    expect(value.length + 2).toBeLessThan(1024);
    expect(errorOf(AggregateId.of("型", value))).toMatchObject({
      rule: "T-12",
    });
  });

  test("asString rejects a typeName containing a hyphen with T-11 and no seqNr", () => {
    const handmade = { typeName: "order-item", value: "1" };
    const error = errorOf(AggregateId.asString(handmade));

    expect(error.type).toBe("contract-violation");
    if (error.type !== "contract-violation") throw new Error("unreachable");
    expect(error.rule).toBe("T-11");
    expect(error.message).toContain("T-11");
    expect("seqNr" in error).toBe(false);
  });

  test("of rejects a typeName containing a hyphen with T-11", () => {
    expect(errorOf(AggregateId.of("a-b", "1"))).toMatchObject({
      rule: "T-11",
    });
  });

  test("asString re-checks T-12 on a handmade object", () => {
    const handmade = { typeName: "t", value: "x".repeat(1024) };

    expect(errorOf(AggregateId.asString(handmade))).toMatchObject({
      rule: "T-12",
    });
  });

  test("of and asString return T-2 for missing or non-string elements", () => {
    expect(errorOf(AggregateId.of(undefined as never, "1"))).toMatchObject({
      rule: "T-2",
    });
    expect(errorOf(AggregateId.of("t", null as never))).toMatchObject({
      rule: "T-2",
    });
    expect(errorOf(AggregateId.of(42 as never, "1"))).toMatchObject({
      rule: "T-2",
    });
    expect(
      errorOf(AggregateId.asString({ value: "1" } as never)),
    ).toMatchObject({ rule: "T-2" });
  });

  test("of returns a frozen value", () => {
    expect(Object.isFrozen(unwrap(AggregateId.of("a", "b")))).toBe(true);
  });
});
