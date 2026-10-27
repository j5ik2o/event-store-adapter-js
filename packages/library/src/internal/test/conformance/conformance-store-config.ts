export type ConformanceStoreConfig = {
  retentionCount: number | null;
  retentionMode: "delete" | "ttl";
  ttlGraceSeconds?: number;
  retryLimit?: number;
  transactionRetryLimit?: number;
  ttlGraceDays?: number;
  changeFeed?: boolean;
  lockWaitMilliseconds?: number;
  envelopeLimitBytes?: number;
};
