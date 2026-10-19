import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { spannerAggregateKey } from "./spanner-aggregate-key";
import type { SpannerEventStoreHooks } from "./spanner-event-store-hooks";
import type { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";
import { spannerRows } from "./spanner-rows";
import { spannerStoredInteger } from "./spanner-stored-integer";
import { validateAggregateId } from "./validated-event-store";

type Settings<PE, PS> = Extract<
  ReturnType<typeof validateSpannerEventStoreInput<PE, PS>>,
  { type: "ok" }
>["value"];

const MIN_NANOS = BigInt("-9223372036854775808");
const MAX_NANOS = BigInt("9223372036854775807");
const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

export function createSpannerGetLatestSnapshot<PE, PS>(
  settings: Settings<PE, PS>,
  hooks?: SpannerEventStoreHooks,
): EventStore<PE, PS>["getLatestSnapshotById"] {
  return async (aggregateId) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    const { hashPrefix, aid } = spannerAggregateKey(validatedId.value);
    const key = { hp: hashPrefix, aid };
    const keyTypes = { hp: "bytes", aid: "string" };

    try {
      await hooks?.beforeReadSnapshot?.();
      // SPN-9: head と snapshot_current を 1 つの strong の読み取り専用トランザクションで読む。
      const [snapshot] = await settings.database.getSnapshot({ strong: true });
      try {
        const heads = await spannerRows(
          snapshot,
          `SELECT type_name, seq_nr, event_occurred_at_ns, event_manifest, event_payload FROM \`${settings.tables.head}\` WHERE hash_prefix = @hp AND aid = @aid`,
          key,
          keyTypes,
        );
        if (heads.length === 0) return Result.ok(undefined);
        const head = heads[0];
        if (head.type_name !== validatedId.value.typeName)
          return Result.err(EventStoreError.storage("invalid head type_name"));
        const headSeqNr = spannerStoredInteger(
          head.seq_nr,
          "head seq_nr",
          BigInt(1),
          MAX_SEQ_NR,
        );
        if (headSeqNr.type === "err") return headSeqNr;
        const eventNanos = spannerStoredInteger(
          head.event_occurred_at_ns,
          "head event_occurred_at_ns",
          MIN_NANOS,
          MAX_NANOS,
        );
        if (eventNanos.type === "err") return eventNanos;
        if (
          typeof head.event_manifest !== "string" ||
          !(head.event_payload instanceof Uint8Array)
        )
          return Result.err(
            EventStoreError.storage("invalid head event manifest or payload"),
          );

        const currents = await spannerRows(
          snapshot,
          `SELECT seq_nr, manifest, payload FROM \`${settings.tables.snapshotCurrent}\` WHERE hash_prefix = @hp AND aid = @aid`,
          key,
          keyTypes,
        );
        if (currents.length === 0)
          return Result.ok(
            Object.freeze({ headSeqNr: Number(headSeqNr.value) }),
          );
        const current = currents[0];
        // R-8: 同じ読み取り時点なので、snapshot.seq_nr は head.seq_nr 以下になる。
        const seqNr = spannerStoredInteger(
          current.seq_nr,
          "snapshot seq_nr",
          BigInt(1),
          headSeqNr.value,
        );
        if (seqNr.type === "err") return seqNr;
        const manifest = current.manifest;
        const bytes = current.payload;
        if (typeof manifest !== "string" || !(bytes instanceof Uint8Array))
          return Result.err(
            EventStoreError.storage("invalid snapshot manifest or payload"),
          );
        try {
          const aggregate = settings.snapshotSerializer.deserialize(
            new Uint8Array(bytes),
            manifest,
          );
          return Result.ok(
            Object.freeze({
              headSeqNr: Number(headSeqNr.value),
              snapshot: Object.freeze({
                seqNr: Number(seqNr.value),
                manifest,
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
      } finally {
        snapshot.end();
      }
    } catch (cause) {
      return Result.err(
        EventStoreError.storage("snapshot query failed", cause),
      );
    }
  };
}
