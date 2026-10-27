import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { guarded } from "./bigtable-guarded";
import { readHead } from "./bigtable-head";
import {
  aggregatePrefixOf,
  type BigtableStoreResources,
} from "./bigtable-store-resources";
import { validateAggregateId } from "./validated-event-store";

export function createBigtableGetLatestSnapshot<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
): EventStore<PE, PS>["getLatestSnapshotById"] {
  return async (aggregateId) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;
    return guarded("snapshot query failed", async () => {
      // BT-8: head と current は、同じ行の 1 回の読み取りで得る。
      const head = await readHead(
        resources.head,
        aggregatePrefixOf(resources, aid),
        aid,
      );
      await resources.hooks?.afterReadHead?.("snapshot");
      if (head === undefined) return Result.ok(undefined);
      const current = head.currentSnapshot;
      if (current === undefined)
        return Result.ok(Object.freeze({ headSeqNr: head.seqNr }));
      try {
        const aggregate = resources.settings.snapshotSerializer.deserialize(
          new Uint8Array(current.fields.payload),
          current.fields.manifest,
        );
        return Result.ok(
          Object.freeze({
            headSeqNr: head.seqNr,
            snapshot: Object.freeze({
              seqNr: current.fields.seqNr,
              manifest: current.fields.manifest,
              aggregate,
            }),
          }),
        );
      } catch (cause) {
        return Result.err(
          EventStoreError.serialization(
            "deserialize",
            "snapshot payload deserialization failed",
            cause,
          ),
        );
      }
    });
  };
}
