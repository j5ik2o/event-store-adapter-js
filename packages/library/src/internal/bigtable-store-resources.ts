import type { BigtableEventStoreHooks } from "./bigtable-event-store-hooks";
import type { validateBigtableEventStoreInput } from "./bigtable-event-store-input-validation";
import type { BigtableTableRequests } from "./bigtable-requests";
import { aggregatePrefix } from "./bigtable-row-keys";
import { fnv1a64 } from "./fnv1a64";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateBigtableEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

/** ストアの 4 操作が共有する、検証済みの設定と 2 つのテーブルへの要求。 */
export type BigtableStoreResources<PE, PS> = Readonly<{
  settings: Settings<PE, PS>;
  journal: BigtableTableRequests;
  head: BigtableTableRequests;
  hooks: BigtableEventStoreHooks | undefined;
}>;

/** aid の行キーの接頭辞 P(aid)。試験では、ハッシュを差し替えて衝突させられる。 */
export function aggregatePrefixOf<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
  aid: string,
): Uint8Array {
  return aggregatePrefix(
    aid,
    resources.hooks?.aggregateHash?.(aid) ?? fnv1a64(aid),
  );
}
