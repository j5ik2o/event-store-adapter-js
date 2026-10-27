import type { BigtableEventFields } from "./bigtable-event-fields";
import type { BigtableSnapshotFields } from "./bigtable-snapshot-fields";

/** 取得して検証した head の行。 */
export type BigtableHeadState = Readonly<{
  seqNr: number;
  lastEventBytes: Uint8Array;
  lastEvent: BigtableEventFields;
  hasSnapshot: boolean;
  /** head のイベントと同時に書いたスナップショットの封筒。伴わなければ undefined。 */
  tailSnapshotBytes: Uint8Array | undefined;
  currentSnapshot:
    | Readonly<{ bytes: Uint8Array; fields: BigtableSnapshotFields }>
    | undefined;
}>;
