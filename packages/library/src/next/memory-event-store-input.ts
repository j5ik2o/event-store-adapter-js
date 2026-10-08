import type { Logger } from "../logger";
import type { MemoryStorage } from "./memory-storage";
import type { PayloadSerializer } from "./payload-serializer";
import type { RetentionFailure } from "./retention-failure";

export type MemoryEventStoreInput<PE, PS> = Readonly<{
  storage?: MemoryStorage;
  eventSerializer?: PayloadSerializer<PE>;
  snapshotSerializer?: PayloadSerializer<PS>;
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
}>;
