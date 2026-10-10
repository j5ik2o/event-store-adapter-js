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

export function storeCreationOf(c: ConformanceCase): ConformanceStoreCreation {
  const retentionCount = jsonAt(c.body, "store", "retention_count");
  const retentionMode = jsonAt(c.body, "store", "retention_mode");
  const ttlGraceSeconds = jsonAt(c.body, "store", "ttl_grace_seconds");
  const retryLimit = jsonAt(c.body, "store", "retry_limit");
  return {
    config: {
      retentionCount:
        typeof retentionCount === "number" ? retentionCount : null,
      retentionMode: retentionMode === "ttl" ? "ttl" : "delete",
      ...(typeof ttlGraceSeconds === "number" ? { ttlGraceSeconds } : {}),
      ...(typeof retryLimit === "number" ? { retryLimit } : {}),
    },
    seedItems: arrayAt(c.body, "seed", "items"),
    faults: arrayAt(c.body, "faults"),
    fixtures: jsonAt(c.body, "fixtures"),
    clockEpochSeconds: jsonAt(c.body, "clock", "epoch_seconds") as
      | number
      | undefined,
  };
}
