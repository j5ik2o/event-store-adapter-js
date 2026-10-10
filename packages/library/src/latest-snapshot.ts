import type { SnapshotEnvelope } from "./snapshot-envelope";

export type LatestSnapshot<S = unknown> = Readonly<{
  snapshot?: SnapshotEnvelope<S>;
  headSeqNr: number;
}>;
