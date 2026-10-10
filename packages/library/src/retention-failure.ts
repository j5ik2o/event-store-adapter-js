export type RetentionFailure = Readonly<{
  kind: "retention-failure";
  aggregateId: string;
  cause: unknown;
}>;
