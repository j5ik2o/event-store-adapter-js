import type { MemoryRetentionHooks } from "./memory-retention-hooks";

/** 内部試験用。検査後の確定前・読取前と既存保持処理の差し込み口。 */
export type MemoryEventStoreHooks = MemoryRetentionHooks &
  Readonly<{
    beforeCommit?: () => void | Promise<void>;
    beforeReadEvents?: () => void | Promise<void>;
    beforeReadSnapshot?: () => void | Promise<void>;
  }>;
