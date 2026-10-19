export type SpannerSnapshotRetention = Readonly<{
  count: number;
  mode?: "delete" | { type: "ttl"; graceDays: number };
}>;
