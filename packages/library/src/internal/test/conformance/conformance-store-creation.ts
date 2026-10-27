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
  seedConfiguration?: ConformanceJsonValue;
  rowDeletionPolicyDays?: number | null;
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
  "transaction_retry_limit",
  "ttl_grace_days",
  "lock_wait_milliseconds",
];
const KNOWN_SEED_KEYS: readonly string[] = [
  "items",
  "configuration",
  "row_deletion_policy_days",
];

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
  const transactionRetryLimit = jsonAt(
    c.body,
    "store",
    "transaction_retry_limit",
  );
  const ttlGraceDays = jsonAt(c.body, "store", "ttl_grace_days");
  const lockWaitMilliseconds = jsonAt(
    c.body,
    "store",
    "lock_wait_milliseconds",
  );
  const seedConfiguration = jsonAt(c.body, "seed", "configuration");
  const rowDeletionPolicyDays = jsonAt(
    c.body,
    "seed",
    "row_deletion_policy_days",
  );
  return {
    config: {
      retentionCount:
        typeof retentionCount === "number" ? retentionCount : null,
      retentionMode: retentionMode === "ttl" ? "ttl" : "delete",
      ...(typeof ttlGraceSeconds === "number" ? { ttlGraceSeconds } : {}),
      ...(typeof retryLimit === "number" ? { retryLimit } : {}),
      ...(changeFeed === true ? { changeFeed: true } : {}),
      ...(typeof transactionRetryLimit === "number"
        ? { transactionRetryLimit }
        : {}),
      ...(typeof ttlGraceDays === "number" ? { ttlGraceDays } : {}),
      ...(typeof lockWaitMilliseconds === "number"
        ? { lockWaitMilliseconds }
        : {}),
    },
    seedItems: arrayAt(c.body, "seed", "items"),
    faults: arrayAt(c.body, "faults"),
    fixtures: jsonAt(c.body, "fixtures"),
    clockEpochSeconds: jsonAt(c.body, "clock", "epoch_seconds") as
      | number
      | undefined,
    ...(seedConfiguration === undefined ? {} : { seedConfiguration }),
    ...(rowDeletionPolicyDays === undefined
      ? {}
      : { rowDeletionPolicyDays: rowDeletionPolicyDays as number | null }),
  };
}
