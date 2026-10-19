import type { EventStore } from "../event-store";
import type { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SpannerEventStoreInput } from "../spanner-event-store-input";
import type { SpannerEventStoreHooks } from "./spanner-event-store-hooks";
import { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";
import { createSpannerGetEvents } from "./spanner-get-events";
import { createSpannerGetLatestSnapshot } from "./spanner-get-latest-snapshot";
import {
  createSpannerPersistEvent,
  createSpannerPersistEventAndSnapshot,
} from "./spanner-persist-event";
import { verifySpannerStoreConfiguration } from "./spanner-store-configuration";

/** 照合後の 4 操作を返す内部入口。DDL は実行しない（SPN-D5）。 */
export async function initializeSpannerEventStoreInternal<
  PE = unknown,
  PS = unknown,
>(
  input: SpannerEventStoreInput<PE, PS>,
  hooks?: SpannerEventStoreHooks,
): Promise<Result<EventStore<PE, PS>, EventStoreError>> {
  const settings = validateSpannerEventStoreInput(input);
  if (settings.type === "err") return settings;
  const verified = await verifySpannerStoreConfiguration(settings.value);
  if (verified.type === "err") return verified;
  return Result.ok(
    Object.freeze({
      persistEvent: createSpannerPersistEvent(settings.value, hooks),
      persistEventAndSnapshot: createSpannerPersistEventAndSnapshot(
        settings.value,
        hooks,
      ),
      getLatestSnapshotById: createSpannerGetLatestSnapshot(
        settings.value,
        hooks,
      ),
      getEventsByIdSinceSeqNr: createSpannerGetEvents(settings.value, hooks),
    }),
  );
}
