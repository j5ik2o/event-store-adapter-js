import type { EventStore } from "./event-store";
import type { EventStoreError } from "./event-store-error";
import { initializeSpannerEventStoreInternal } from "./internal/spanner-event-store";
import type { Result } from "./result";
import type { SpannerEventStoreInput } from "./spanner-event-store-input";

export namespace SpannerEventStore {
  export async function create<PE = unknown, PS = unknown>(
    input: SpannerEventStoreInput<PE, PS>,
  ): Promise<Result<EventStore<PE, PS>, EventStoreError>> {
    return initializeSpannerEventStoreInternal(input);
  }
}

Object.freeze(SpannerEventStore);
