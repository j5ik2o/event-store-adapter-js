export type SnapshotEnvelopeInput<S = unknown> = Readonly<{
  seqNr: number;
  manifest?: string;
  aggregate: S;
}>;
