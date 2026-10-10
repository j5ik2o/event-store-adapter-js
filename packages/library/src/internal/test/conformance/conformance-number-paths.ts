import type { JsonPath } from "./conformance-json-parser";

const PAYLOAD_KEYS = new Set(["payload", "aggregate", "binary_json"]);
const SEQ_NR_KEYS = new Set([
  "seq_nr",
  "event_seq_nr",
  "head_seq_nr",
  "old_head_seq_nr",
]);
const SEQ_NR_ARRAY_KEYS = new Set([
  "active",
  "absent",
  "target_seq_nrs",
  "history_pages",
]);

export function isSeqNrPath(
  format: string | undefined,
  path: JsonPath,
): boolean {
  if (path.some((s) => typeof s === "string" && PAYLOAD_KEYS.has(s))) {
    return false;
  }
  const last = path[path.length - 1];
  if (typeof last === "string" && SEQ_NR_KEYS.has(last)) {
    return true;
  }
  const lastKeyIndex = path.reduce<number>(
    (found, s, i) => (typeof s === "string" ? i : found),
    -1,
  );
  if (lastKeyIndex >= 0) {
    const key = path[lastKeyIndex];
    const rest = path.slice(lastKeyIndex + 1);
    if (
      typeof key === "string" &&
      SEQ_NR_ARRAY_KEYS.has(key) &&
      rest.every((s) => typeof s === "number")
    ) {
      return true;
    }
  }
  return (
    format === "values" &&
    path.length === 4 &&
    path[0] === "cases" &&
    typeof path[1] === "number" &&
    path[2] === "expect" &&
    path[3] === "value"
  );
}
