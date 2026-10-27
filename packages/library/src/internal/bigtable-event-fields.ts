/** イベント封筒の項目（BT-D6a）。 */
export type BigtableEventFields = Readonly<{
  aid: string;
  seqNr: number;
  occurredAtNs: bigint;
  manifest: string;
  payload: Uint8Array;
}>;
