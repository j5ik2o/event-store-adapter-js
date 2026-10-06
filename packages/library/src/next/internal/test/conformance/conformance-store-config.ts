export type ConformanceStoreConfig = {
  retentionCount: number | null;
  retentionMode: "delete" | "ttl";
  ttlGraceSeconds?: number;
  retryLimit?: number;
};
