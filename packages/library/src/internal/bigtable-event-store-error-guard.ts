import type { EventStoreError } from "../event-store-error";

const TYPES: readonly string[] = [
  "optimistic-lock-conflict",
  "contract-violation",
  "serialization-error",
  "configuration-error",
  "storage-error",
];

/** 内部の処理が投げた EventStoreError と、SDK などが投げた別の失敗を見分ける。 */
export function isEventStoreError(value: unknown): value is EventStoreError {
  if (value === null || typeof value !== "object") return false;
  const { type, message } = value as { type?: unknown; message?: unknown };
  return (
    typeof type === "string" &&
    TYPES.includes(type) &&
    typeof message === "string"
  );
}
