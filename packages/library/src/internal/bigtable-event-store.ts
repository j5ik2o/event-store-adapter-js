import type { BigtableEventStoreInput } from "../bigtable-event-store-input";
import type { EventStore } from "../event-store";
import type { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { BigtableEventStoreHooks } from "./bigtable-event-store-hooks";
import { validateBigtableEventStoreInput } from "./bigtable-event-store-input-validation";
import { createBigtableGetEvents } from "./bigtable-get-events";
import { createBigtableGetLatestSnapshot } from "./bigtable-get-latest-snapshot";
import { guarded } from "./bigtable-guarded";
import {
  createBigtablePersistEvent,
  createBigtablePersistEventAndSnapshot,
} from "./bigtable-persist-event";
import type { BigtableRequestContext } from "./bigtable-request-context";
import { BigtableTableRequests } from "./bigtable-requests";
import {
  initializeBigtableStoreRows,
  verifyBigtableStore,
} from "./bigtable-store-configuration";
import type { BigtableStoreResources } from "./bigtable-store-resources";

function contextOf(
  settings: {
    bigtable: BigtableRequestContext["bigtable"];
    instanceId: string;
    accessToken?: () => string | Promise<string>;
  },
  hooks: BigtableEventStoreHooks | undefined,
): BigtableRequestContext {
  return Object.freeze({
    bigtable: settings.bigtable,
    instanceId: settings.instanceId,
    ...(settings.accessToken !== undefined
      ? { accessToken: settings.accessToken }
      : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  });
}

/** 用意済みの 2 つのテーブルに、同じ store_id の設定行を作る（BT-D1）。 */
export async function initializeBigtableStoreInternal<
  PE = unknown,
  PS = unknown,
>(
  input: BigtableEventStoreInput<PE, PS>,
  hooks?: BigtableEventStoreHooks,
): Promise<Result<void, EventStoreError>> {
  const settings = validateBigtableEventStoreInput(input);
  if (settings.type === "err") return settings;
  return guarded("Bigtable store could not be initialized", async () => {
    await initializeBigtableStoreRows(
      contextOf(settings.value, hooks),
      settings.value,
    );
    return Result.ok(undefined);
  });
}

/** 照合後の 4 操作を返す内部入口。テーブルも設定行も作らない。 */
export async function openBigtableEventStoreInternal<
  PE = unknown,
  PS = unknown,
>(
  input: BigtableEventStoreInput<PE, PS>,
  hooks?: BigtableEventStoreHooks,
): Promise<Result<EventStore<PE, PS>, EventStoreError>> {
  const settings = validateBigtableEventStoreInput(input);
  if (settings.type === "err") return settings;
  const context = contextOf(settings.value, hooks);
  const verified = await guarded(
    "Bigtable store could not be verified",
    async () => {
      await verifyBigtableStore(context, settings.value);
      return Result.ok(undefined);
    },
  );
  if (verified.type === "err") return verified;
  const resources: BigtableStoreResources<PE, PS> = Object.freeze({
    settings: settings.value,
    journal: new BigtableTableRequests(context, settings.value.tables.journal),
    head: new BigtableTableRequests(context, settings.value.tables.head),
    hooks,
  });
  return Result.ok(
    Object.freeze({
      persistEvent: createBigtablePersistEvent(resources),
      persistEventAndSnapshot: createBigtablePersistEventAndSnapshot(resources),
      getLatestSnapshotById: createBigtableGetLatestSnapshot(resources),
      getEventsByIdSinceSeqNr: createBigtableGetEvents(resources),
    }),
  );
}
