import type { SnapshotRetention } from "./snapshot-retention";

export type MemoryStorageInput = Readonly<{
  retention?: SnapshotRetention;
  changeFeed?: unknown;
}>;
