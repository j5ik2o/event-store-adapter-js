import { EventStoreError } from "../event-store-error";
import type { BigtableRecordedConfiguration } from "./bigtable-recorded-configuration";

const invalid = (message: string) =>
  EventStoreError.configuration(
    "configuration",
    `the recorded configuration is invalid: ${message}`,
  );

/** 最上位のオブジェクトのキーを、現れた順に返す。文字列の中の引用符はキーに数えない。構文は検査済みの JSON を前提とする。 */
function topLevelKeys(text: string): readonly string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey) {
        keys.push(JSON.parse(text.slice(index, end + 1)) as string);
        expectKey = false;
      }
      index = end;
    } else if (char === "{" || char === "[") {
      depth += 1;
      expectKey = char === "{" && depth === 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectKey = true;
    }
  }
  return keys;
}

/** 保持件数は、先頭にゼロを置かない正の 10 進文字列だけを受け付ける。 */
function parseKeepSnapshotCount(text: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function parseConfigurationJson(
  bytes: Uint8Array,
): BigtableRecordedConfiguration {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (cause) {
    throw EventStoreError.configuration(
      "configuration",
      "the recorded configuration is not JSON",
      cause,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalid("it is not an object");
  const keys = topLevelKeys(text);
  if (new Set(keys).size !== keys.length) throw invalid("a key is duplicated");
  const record = parsed as Record<string, unknown>;
  const { store_id, layout_version, retention_mode, envelope_limit_bytes } =
    record;
  const keep = record.keep_snapshot_count;
  if (typeof store_id !== "string") throw invalid("store_id");
  if (typeof layout_version !== "number" || !Number.isInteger(layout_version))
    throw invalid("layout_version");
  if (typeof retention_mode !== "string") throw invalid("retention_mode");
  if (
    typeof envelope_limit_bytes !== "number" ||
    !Number.isSafeInteger(envelope_limit_bytes) ||
    envelope_limit_bytes < 0
  )
    throw invalid("envelope_limit_bytes");
  let keepSnapshotCount: number | null;
  if (keep === null) {
    keepSnapshotCount = null;
  } else {
    const count =
      typeof keep === "string" ? parseKeepSnapshotCount(keep) : undefined;
    if (count === undefined) throw invalid("keep_snapshot_count");
    keepSnapshotCount = count;
  }
  return Object.freeze({
    storeId: store_id,
    layoutVersion: layout_version,
    keepSnapshotCount,
    retentionMode: retention_mode,
    envelopeLimitBytes: envelope_limit_bytes,
  });
}

export function renderConfigurationJson(
  record: BigtableRecordedConfiguration,
): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      store_id: record.storeId,
      layout_version: record.layoutVersion,
      keep_snapshot_count:
        record.keepSnapshotCount === null
          ? null
          : String(record.keepSnapshotCount),
      retention_mode: record.retentionMode,
      envelope_limit_bytes: record.envelopeLimitBytes,
    }),
    "utf8",
  );
}
