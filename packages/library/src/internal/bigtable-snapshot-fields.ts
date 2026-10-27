/** スナップショット封筒の項目（BT-D6a）。 */
export type BigtableSnapshotFields = Readonly<{
  seqNr: number;
  manifest: string;
  payload: Uint8Array;
}>;
