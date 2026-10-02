import { createHash } from "node:crypto";
import type { Digest, Issue, JsonValue, ReasonCode } from "./contract.ts";

export class ContractError extends Error {
  readonly issue: Issue;
  constructor(subject: string, message: string, code: ReasonCode = "invalid-request") {
    super(message);
    this.issue = { code, subject, message, location: null };
  }
}

export function requireValue(condition: unknown, subject: string, message: string): asserts condition {
  if (!condition) throw new ContractError(subject, message);
}

export function record(value: unknown, subject: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), subject, "Expected an object.");
  return value as Record<string, unknown>;
}

export function nonempty(value: unknown, subject: string): string {
  requireValue(typeof value === "string" && value.length > 0, subject, "Expected a nonempty string.");
  return value;
}

export function array(value: unknown, subject: string, minimum = 0): unknown[] {
  requireValue(Array.isArray(value) && value.length >= minimum, subject, `Expected at least ${minimum} array items.`);
  return value;
}

export function integer(value: unknown, subject: string, minimum = 0): number {
  requireValue(
    Number.isSafeInteger(value) && (value as number) >= minimum,
    subject,
    "Expected a safe integer in range.",
  );
  return value as number;
}

export function scalarCompare(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) as number);
  const b = Array.from(right, (char) => char.codePointAt(0) as number);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function validString(value: string, subject: string): void {
  for (const char of value) {
    const point = char.codePointAt(0) as number;
    requireValue(point < 0xd800 || point > 0xdfff, subject, "Unpaired Unicode surrogate.");
  }
}

/** Iterative ancestor tracking permits shared values without accepting cycles. */
export function jsonCopy(input: unknown, subject: string): JsonValue {
  type Visit = { value: unknown; subject: string; assign: (value: JsonValue) => void };
  const ancestors = new Set<object>();
  let result: JsonValue = null;
  const pending: (Visit | { leave: object })[] = [
    {
      value: input,
      subject,
      assign: (value) => {
        result = value;
      },
    },
  ];
  while (pending.length) {
    const task = pending.pop() as Visit | { leave: object };
    if ("leave" in task) {
      ancestors.delete(task.leave);
      continue;
    }
    const { value, subject: field, assign } = task;
    if (value === null || typeof value === "boolean") {
      assign(value);
      continue;
    }
    if (typeof value === "string") {
      validString(value, field);
      assign(value);
      continue;
    }
    if (typeof value === "number") {
      requireValue(Number.isSafeInteger(value), field, "Expected a JSON safe integer.");
      assign(Object.is(value, -0) ? 0 : value);
      continue;
    }
    requireValue(typeof value === "object" && value !== null, field, "Expected a JSON-compatible value.");
    requireValue(!ancestors.has(value), field, "Cyclic JSON value.");
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    requireValue(
      isArray ? prototype === Array.prototype : prototype === Object.prototype || prototype === null,
      field,
      "Expected a plain object or array.",
    );
    const keys = Reflect.ownKeys(value).filter((key) => !(isArray && key === "length"));
    requireValue(
      keys.every((key) => typeof key === "string"),
      field,
      "Symbol keys are not JSON-compatible.",
    );
    if (isArray)
      requireValue(
        keys.length === value.length && keys.every((key, i) => key === String(i)),
        field,
        "Sparse or extended array.",
      );
    const copy: Record<string, JsonValue> | JsonValue[] = isArray ? [] : {};
    assign(copy);
    ancestors.add(value);
    pending.push({ leave: value });
    for (const key of keys.reverse() as string[]) {
      validString(key, field);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireValue(descriptor?.enumerable && "value" in descriptor, field, "Expected an enumerable data property.");
      pending.push({
        value: descriptor.value,
        subject: `${field}.${key}`,
        assign: (child) => {
          Object.defineProperty(copy, key, { value: child, enumerable: true, writable: true, configurable: true });
        },
      });
    }
  }
  return result;
}

/** Canonicalize already validated JSON without recursion or integer-key reordering. */
export function canonicalJson(value: JsonValue): string {
  const chunks: string[] = [];
  const pending: ({ value: JsonValue } | { text: string })[] = [{ value }];
  while (pending.length) {
    const task = pending.pop() as { value: JsonValue } | { text: string };
    if ("text" in task) {
      chunks.push(task.text);
      continue;
    }
    const item = task.value;
    if (item === null || typeof item !== "object") {
      chunks.push(JSON.stringify(item));
      continue;
    }
    const isArray = Array.isArray(item);
    const keys = isArray ? item.map((_, index) => String(index)) : Object.keys(item).sort(scalarCompare);
    chunks.push(isArray ? "[" : "{");
    pending.push({ text: isArray ? "]" : "}" });
    for (let i = keys.length - 1; i >= 0; i--) {
      if (i < keys.length - 1) pending.push({ text: "," });
      pending.push({ value: (item as Record<string, JsonValue>)[keys[i]] });
      if (!isArray) pending.push({ text: `${JSON.stringify(keys[i])}:` });
    }
  }
  return chunks.join("");
}

export function digest(text: string): Digest {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function withoutFields(value: Record<string, unknown>, fields: readonly string[], subject: string): void {
  for (const field of fields)
    requireValue(!Object.hasOwn(value, field), `${subject}.${field}`, "Field contradicts the selected tag.");
}
