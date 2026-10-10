/** 内部試験用。実際の保持要求を維持して時計と再送待機だけを差し替える。 */
export type DynamoDBRetentionHooks = Readonly<{
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;
