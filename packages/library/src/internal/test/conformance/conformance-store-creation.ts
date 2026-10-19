import type { ConformanceCase } from "./conformance-case";
import { jsonAt } from "./conformance-json-lookup";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceStoreConfig } from "./conformance-store-config";

export type ConformanceStoreCreation = {
  config: ConformanceStoreConfig;
  seedItems: readonly ConformanceJsonValue[];
  faults: readonly ConformanceJsonValue[];
  fixtures?: ConformanceJsonValue;
  clockEpochSeconds?: number;
};

const arrayAt = (
  body: ConformanceJsonValue,
  ...keys: readonly string[]
): readonly ConformanceJsonValue[] => {
  const v = jsonAt(body, ...keys);
  return Array.isArray(v) ? (v as readonly ConformanceJsonValue[]) : [];
};

const KNOWN_STORE_KEYS: readonly string[] = [
  "retention_count",
  "retention_mode",
  "ttl_grace_seconds",
  "layout_version",
  "retry_limit",
  "change_feed",
];
const KNOWN_SEED_KEYS: readonly string[] = ["items"];

// 解釈できない項目を黙って無視すると、設定が効いていない成功を見逃す
const rejectUnknownKeys = (
  value: ConformanceJsonValue | undefined,
  known: readonly string[],
  label: string,
): void => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const unknown = Object.keys(value).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    throw new Error(`unsupported ${label} ${unknown}`);
  }
};

export function storeCreationOf(c: ConformanceCase): ConformanceStoreCreation {
  rejectUnknownKeys(jsonAt(c.body, "store"), KNOWN_STORE_KEYS, "store setting");
  rejectUnknownKeys(jsonAt(c.body, "seed"), KNOWN_SEED_KEYS, "seed entry");
  const retentionCount = jsonAt(c.body, "store", "retention_count");
  const retentionMode = jsonAt(c.body, "store", "retention_mode");
  const ttlGraceSeconds = jsonAt(c.body, "store", "ttl_grace_seconds");
  const retryLimit = jsonAt(c.body, "store", "retry_limit");
  const changeFeed = jsonAt(c.body, "store", "change_feed");
  return {
    config: {
      retentionCount:
        typeof retentionCount === "number" ? retentionCount : null,
      retentionMode: retentionMode === "ttl" ? "ttl" : "delete",
      ...(typeof ttlGraceSeconds === "number" ? { ttlGraceSeconds } : {}),
      ...(typeof retryLimit === "number" ? { retryLimit } : {}),
      ...(changeFeed === true ? { changeFeed: true } : {}),
    },
    seedItems: arrayAt(c.body, "seed", "items"),
    faults: arrayAt(c.body, "faults"),
    fixtures: jsonAt(c.body, "fixtures"),
    clockEpochSeconds: jsonAt(c.body, "clock", "epoch_seconds") as
      | number
      | undefined,
  };
}
