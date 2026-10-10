export type SnapshotRetention = Readonly<{
  count: number;
  mode?: { type: "delete" } | { type: "ttl"; graceSeconds: number };
}>;
