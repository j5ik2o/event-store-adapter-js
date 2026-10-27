/** 設定行に記録された内容。 */
export type BigtableRecordedConfiguration = Readonly<{
  storeId: string;
  layoutVersion: number;
  keepSnapshotCount: number | null;
  retentionMode: string;
  envelopeLimitBytes: number;
}>;
